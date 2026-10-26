# @paraf/core

The headless approval workflow engine of [Paraf](../../README.md): flow definitions, the
engine, a flow validator and JSON Schema, an in-memory store, and a UUID v7 generator. Zero
runtime dependencies.

> [!WARNING]
> Early development. The API may still change before `1.0.0`.

**Contents:** [Quick start](#quick-start) · [Concepts](#concepts) ·
[Approvers](#approvers-and-resolvers) · [Modes, groups, rejections](#how-many-must-approve-mode) ·
[Chains](#approval-chains) · [Conditions](#conditions) · [Subjects](#subjects-linking-approvals-to-your-tables) ·
[Actions](#actions-and-who-may-take-them) · [Timeouts](#timeouts-and-escalation) ·
[Events](#events) · [Errors](#errors) · [API reference](#api-reference)

## Quick start

Requires Node.js 24 or newer.

```sh
npm install @paraf/core
```

```ts
import { createEngine, MemoryStore } from '@paraf/core';

// 1. An engine with a store. Use @paraf/postgres or @paraf/mysql in production.
const engine = createEngine({ store: new MemoryStore() });

// 2. Tell Paraf how to find approvers in YOUR app.
engine.registerApproverType('role', async ({ value }) => db.userIdsWithRoles(value));
engine.registerApproverType('supervisor', async ({ level }, { requester }) =>
  db.managerOf(requester.id, Number(level ?? 1)),
);

// 3. Publish a flow (validated, stored as version 1, made active).
await engine.publishFlow({
  id: 'purchase-request',
  name: 'Purchase request',
  start: 'manager',
  nodes: {
    manager: {
      type: 'approval',
      approvers: [{ type: 'supervisor', level: 1 }],
      mode: 'any',
      next: 'finance',
      onReject: 'rejected',
    },
    finance: {
      type: 'approval',
      approvers: [{ type: 'role', value: 'finance' }],
      mode: { minimum: 2 },
      next: 'approved',
      onReject: 'rejected',
    },
    approved: { type: 'end', result: 'approved' },
    rejected: { type: 'end', result: 'rejected' },
  },
});

// 4. React to what happens: notify approvers, update your tables.
engine.on('approval.required', ({ groups }) => notify(groups.flatMap((group) => group.userIds)));
engine.on('instance.completed', ({ instance }) =>
  db.purchaseRequests.setStatus(instance.subject.id, instance.status),
);

// 5. Start an approval for one of your documents, and decide.
const instance = await engine.start('purchase-request', {
  subject: { type: 'purchase_request', id: '42' },
  requester: { id: 'u7' },
  document: { amount: 15_000_000 },
});
await engine.approve(instance.id, 's1', 'Looks good');
```

Runnable versions: [`examples/basic-node`](../../examples/basic-node) (in memory) and
[`examples/express-postgres`](../../examples/express-postgres) (an Express API on PostgreSQL).

## Concepts

- A **flow** is a JSON document: nodes connected by their `next` / `onReject` / `else`
  references, starting at `start`. Publishing a flow stores it as a new, immutable **version**
  and makes it the active one.
- An **instance** is one run of a flow for one of your documents (the **subject**). It keeps the
  flow version it started with, even after newer versions are published.
- Entering an approval node creates a **step**. Its approvers are resolved at that moment, from
  your data, and get one **slot** each (per group).
- Every decision and transition is appended to the **audit trail**, and emitted as an
  **event** once stored.

| Node             | Does                                                                                   | Continues with           |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------ |
| `approval`       | Waits for approvers: one group (`approvers`, `mode`) or several in parallel (`groups`) | `next` / `onReject`      |
| `approval-chain` | Walks a chain (e.g. supervisors) one level at a time until a condition is met          | `next` / `onReject`      |
| `condition`      | Picks the first rule whose expression matches the document                             | a rule's `next` / `else` |
| `end`            | Finishes the instance as `approved` or `rejected`                                      | —                        |

Instance statuses: `pending` (no decision yet in this round), `in_progress`, `returned` (back
with the requester), and the final `approved`, `rejected`, `cancelled`. A subject has at most one
running instance (`pending`, `in_progress`, or `returned`) at a time.

## Approvers and resolvers

An approver entry names a **type** and its settings: `{ type: 'role', value: 'finance' }`. The
engine calls the resolver registered for that type when the step starts; it returns user IDs.
Entries of one group are merged, and each person gets **one vote** even when several entries
resolve to them.

Built in: `{ type: 'user', value: 'u1' | ['u1', 'u2'] }` (fixed users) and
`{ type: 'field', value: 'pic.user_id' }` (user IDs read from the document). Register the rest:

```ts
// Everyone with one of the roles: { type: 'role', value: 'finance' | ['finance', 'accounting'] }
engine.registerApproverType('role', async ({ value }) => {
  const roles = Array.isArray(value) ? value : [value];
  const rows = await sql`SELECT id FROM users WHERE role = ANY(${roles}) AND active`;
  return rows.map((row) => row.id);
});

// Members of a group or team: { type: 'group', value: 'procurement-committee' }
engine.registerApproverType('group', async ({ value }) => {
  const rows = await sql`SELECT user_id FROM group_members WHERE group_id = ${value}`;
  return rows.map((row) => row.user_id);
});

// The requester's manager, `level` steps up: { type: 'supervisor', level: 2 }
engine.registerApproverType('supervisor', async ({ level }, { requester }) => {
  let userId = requester.id;
  for (let i = 0; i < Number(level ?? 1); i++) {
    const [row] = await sql`SELECT manager_id FROM users WHERE id = ${userId}`;
    if (!row?.manager_id) return [];
    userId = row.manager_id;
  }
  return [userId];
});
```

The resolver's second argument is the context: `requester`, `subject`, `document`, `instance`,
`nodeId`, and `groupId`. The third argument of `registerApproverType` is optional metadata for
the editor (`label`, `description`, and a `configSchema` describing the settings form, whose
`options` may be loaded lazily).

## How many must approve: `mode`

| `mode`           | The group is approved when…    | Example: 4 people in the group |
| ---------------- | ------------------------------ | ------------------------------ |
| `'any'`          | one person approves            | 1 approval                     |
| `'all'`          | every resolved person approves | 4 approvals                    |
| `{ minimum: n }` | `n` people approve             | `{ minimum: 2 }`: 2 approvals  |

## When a group is rejected: `rejectPolicy`

| `rejectPolicy`   | The group is rejected when…                                   | Default for      |
| ---------------- | ------------------------------------------------------------- | ---------------- |
| `'any'`          | the first person rejects                                      | `'any'`, `'all'` |
| `'impossible'`   | approvals plus pending people can no longer reach the minimum | `{ minimum: n }` |
| `{ minimum: n }` | `n` people have rejected                                      | —                |

Example, 5 people with `mode: { minimum: 2 }`:

| `rejectPolicy`   | Rejected after                                                    |
| ---------------- | ----------------------------------------------------------------- |
| `'impossible'`   | the 4th rejection (only 1 person is left, 2 approvals are needed) |
| `'any'`          | the 1st rejection                                                 |
| `{ minimum: 2 }` | the 2nd rejection                                                 |

Whatever the policy, a group is also rejected as soon as it can no longer be approved, so a step
never waits forever.

## Parallel groups: `groups`, `require`, `countAcrossGroups`

An approval node can ask several groups at once, each with its own approvers and rules:

```ts
review: {
  type: 'approval',
  groups: [
    { id: 'mgr', label: 'Manager', approvers: [{ type: 'role', value: 'manager' }], mode: 'any' },
    {
      id: 'fin',
      label: 'Finance',
      approvers: [{ type: 'role', value: ['finance', 'accounting'] }],
      mode: { minimum: 2 },
    },
  ],
  require: 'all', // both groups
  next: 'approved',
  onReject: 'rejected',
}
```

| `require`         | The node is approved when… | With groups `mgr` and `fin` above       |
| ----------------- | -------------------------- | --------------------------------------- |
| `'all'` (default) | every group is approved    | 1 manager **and** 2 from finance        |
| `'any'`           | one group is approved      | 1 manager **or** 2 from finance         |
| `{ minimum: n }`  | `n` groups are approved    | `{ minimum: 1 }` is the same as `'any'` |

The node is rejected as soon as too few groups can still be approved. A person in two groups
votes in both (`countAcrossGroups: true`, default) or only in the first group that contains them
(`false`). A node with `approvers` and `mode` directly is a single group with id `"default"`.

## Too few approvers, or none

| Setting                                    | `'error'` (default)                     | `'skip'`                                   | `'cap'`                        | `'fallback'`                         |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------ | ------------------------------ | ------------------------------------ |
| `onEmptyApprovers` (nobody resolved)       | the action fails, nothing changes       | the group is skipped (counts as satisfied) | —                              | use `fallbackApprovers`              |
| `onInsufficientApprovers` (fewer than `n`) | fails with `InsufficientApproversError` | —                                          | lower the minimum to the count | add `fallbackApprovers` until enough |

`excludeRequester: true` removes the requester from the resolved approvers first.

## Approval chains

"Up the reporting line until a director" is an `approval-chain` node. Register how to go one
level up, then let the node walk it, creating one step per level:

```ts
engine.registerChain('reporting-line', async (userId) => {
  const [row] = await sql`SELECT manager_id FROM users WHERE id = ${userId}`;
  return row?.manager_id ?? null; // null: top of the chain
});
```

```ts
up_to_director: {
  type: 'approval-chain',
  chain: 'reporting-line',
  from: 'requester',                         // or { field: 'pic.user_id' }
  until: { type: 'role', value: 'director' }, // stop at the first director
  includeStopper: true,                      // the director approves too (default)
  maxLevels: 5,                              // safety limit
  next: 'finance',
  onReject: 'rejected',                      // any level rejecting rejects the node
}
```

Cycles in the chain are detected (`ChainCycleError`).

**Same person at several levels:** `duplicateApprover: 'auto-approve'` on an approval or chain
node approves automatically for someone who already approved an earlier step of the same round
(e.g. the direct manager who is also the first chain level). The default `'require'` asks them
again.

## Conditions

```ts
check_amount: {
  type: 'condition',
  rules: [
    { when: { '>': [{ var: 'amount' }, 10_000_000] }, next: 'director', label: 'Above 10M' },
    { when: { in: [{ var: 'department' }, ['IT', 'Security']] }, next: 'it_review' },
  ],
  else: 'finance',
}
```

Expressions are JSON Logic style, evaluated against the document without `eval`. Operators:
`==`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `and`, `or`, `not`, and `var` (a dot path such as
`items.0.price`). Add your own with `engine.registerOperator('startsWith', ([text, prefix]) =>
String(text).startsWith(String(prefix)))`.

## Document variables

A flow can declare the document fields it expects. The editor offers them in conditions and
approver settings, and `start` and `resubmit` check the document against them (throwing a
`DocumentValidationError` that lists every problem):

```ts
import { validateDocument } from '@paraf/core';

const variables = [
  { key: 'amount', label: 'Amount', type: 'number', required: true },
  { key: 'department', type: 'select', options: ['IT', 'Finance'] },
  { key: 'pic.user_id', type: 'user' }, // a dotted key reads a nested field
];
// flow.variables = variables

validateDocument({ amount: '15' }, variables);
// [{ key: 'amount', message: 'Amount (amount) must be a number' }]
```

Types: `number`, `text`, `select` (one of `options`), `date` (ISO 8601), `boolean`, and `user`
(a user ID). Fields that are not declared are not checked.

## Subjects: linking approvals to your tables

Paraf never touches your tables. An instance points at your record through its **subject**:
`{ type: 'purchase_request', id: '42' }`, stored as `subject_type` and `subject_id`. Keep your
own status column up to date from an event, and join when you need both:

```ts
const instance = await engine.start('purchase-request', {
  subject: { type: 'purchase_request', id: String(request.id) },
  requester: { id: currentUser.id },
  document: { amount: request.amount, department: request.department },
});

engine.on('instance.completed', async ({ instance }) => {
  if (instance.subject.type === 'purchase_request') {
    await sql`UPDATE purchase_requests SET status = ${instance.status} WHERE id = ${instance.subject.id}`;
  }
});
```

```sql
-- Purchase requests with their current approval (PostgreSQL adapter, default prefix)
SELECT pr.*, i.status AS approval_status
FROM purchase_requests pr
LEFT JOIN paraf_instances i
  ON i.subject_type = 'purchase_request'
 AND i.subject_id = pr.id::text
 AND i.status IN ('pending', 'in_progress', 'returned');
```

`engine.findInstances({ subject: { type: 'purchase_request', id: '42' } })` returns every
instance of a record (newest first), including finished ones.

## Approve and reject

With the flow from the [Quick start](#quick-start): the requester's supervisor `s1` decides
first, then two of the three finance people `f1`, `f2`, `f3` must approve.

```ts
// What is waiting for s1: their inbox.
const inbox = await engine.findPendingForUser('s1');
// inbox.items: [{ instance, stepId, nodeId: 'manager', groupIds, enteredAt, dueAt }]
const instanceId = inbox.items[0].instance.id;

// Approve. The comment is optional.
let instance = await engine.approve(instanceId, 's1', 'Looks good');
instance.status; // 'in_progress': the manager step is done, finance is asked now

// Reject. The comment is required: it tells the requester why.
instance = await engine.reject(instanceId, 'f1', 'The quote is missing');
instance.status; // still 'in_progress': f2 and f3 can still make the 2 approvals

await engine.approve(instanceId, 'f2');
instance = await engine.approve(instanceId, 'f3');
instance.status; // 'approved'
```

Whether one decision finishes a step depends on the node's [`mode`](#how-many-must-approve-mode)
and [`rejectPolicy`](#when-a-group-is-rejected-rejectpolicy). Had `s1` rejected, the manager
step (`mode: 'any'`) would have been rejected at once and the instance would have followed
`onReject` to the `rejected` end: `instance.status` would be `'rejected'`.

Every decision returns the updated `Instance`, is written to the audit trail with its comment
(`engine.getHistory(instanceId)`), and emits [events](#events). React to the outcome there
rather than after each call, because it may come from any approver, or from a timeout:

```ts
engine.on('instance.completed', async ({ instance }) => {
  // instance.status: 'approved', 'rejected', or 'cancelled'
  await db.purchaseRequests.setStatus(instance.subject.id, instance.status);
  await notify(instance.requesterId, `Your purchase request was ${instance.status}.`);
});
```

A decision that is not allowed throws, and changes nothing:

| Error                   | When                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `NotAuthorizedError`    | the user is not a pending approver of the active step (not asked, or already decided) |
| `InvalidArgumentError`  | `reject` without a comment                                                            |
| `InvalidStateError`     | the instance is finished, or returned to the requester                                |
| `InstanceNotFoundError` | no instance with that ID                                                              |

In an HTTP API, take the user from your login, never from the request body:

```ts
import { InstanceNotFoundError, NotAuthorizedError, ParafError } from '@paraf/core';

app.post('/approvals/:instanceId/approve', async (req, res) => {
  const instance = await engine.approve(req.params.instanceId, req.user.id, req.body?.comment);
  res.json({ status: instance.status });
});

app.post('/approvals/:instanceId/reject', async (req, res) => {
  const instance = await engine.reject(req.params.instanceId, req.user.id, req.body?.comment);
  res.json({ status: instance.status });
});

// Paraf errors to HTTP statuses (Express 5 passes errors of async handlers here).
app.use((error, req, res, next) => {
  const status =
    error instanceof NotAuthorizedError
      ? 403
      : error instanceof InstanceNotFoundError
        ? 404
        : error instanceof ParafError
          ? 400
          : 500;
  res.status(status).json({ error: status === 500 ? 'Internal error' : error.message });
});
```

[`examples/express-postgres`](../../examples/express-postgres) runs this against PostgreSQL.

## Actions and who may take them

| Method                                                  | Who                                   | Effect                                                                  |
| ------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| `approve(instanceId, userId, comment?)`                 | a pending approver of the active step | records the approval; the step and instance move on when decided        |
| `reject(instanceId, userId, comment)`                   | a pending approver                    | records the rejection (comment required)                                |
| `returnForRevision(instanceId, userId, comment, opts?)` | a pending approver, or an admin       | back to the requester, or `{ toNodeId }` to an earlier approval node    |
| `resubmit(instanceId, userId, document?)`               | the requester                         | continues per `resubmitPolicy`: `'restart'` (default) or `'resume'`     |
| `delegate(instanceId, fromUserId, toUserId, reason?)`   | a pending approver                    | moves their vote; refused if a group's minimum would become unreachable |
| `cancel(instanceId, userId, reason?)`                   | the requester, or an admin            | finishes the instance as `cancelled`                                    |
| `reresolveApprovers(instanceId, actorId)`               | an admin                              | resolves the active step's approvers again, keeping decisions made      |

Admins are whoever `createEngine({ isAdmin })` says (default: nobody). Every action is safe
under concurrency: the store applies an update only on the revision it was computed from, and
the engine retries (`maxRetries`, default 3) before throwing `ConcurrencyError`.

## Timeouts and escalation

```ts
manager: {
  type: 'approval',
  approvers: [{ type: 'supervisor', level: 1 }],
  mode: 'any',
  timeout: { after: 'P3D', action: 'escalate', to: [{ type: 'supervisor', level: 2 }] },
  next: 'finance',
  onReject: 'rejected',
}
```

`after` is an ISO 8601 duration (`P3D`, `PT12H`, `P1DT6H`). Entering the step sets its `dueAt`.
The engine runs no timers: call `processTimeouts()` from your scheduler. Each overdue step
escalates once: the `to` approvers join it, and one decision of theirs decides the whole step
(the original approvers can still act too).

```ts
cron.schedule('*/5 * * * *', async () => {
  const { escalated, failed } = await engine.processTimeouts();
});
```

## Events

`engine.on(name, handler)` returns a function that unsubscribes. Handlers run after the action
is stored, one after another; a failing handler does not undo the action (it is reported to
`onEventError`, default `console.error`).

| Event                  | When                                                           | Payload                                          |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `instance.created`     | an instance started                                            | `instance`                                       |
| `step.entered`         | an approval step started                                       | `instance`, `step`                               |
| `approval.required`    | people must act (entered, delegated, re-resolved, escalated)   | `instance`, `step`, `reason`, `groups[].userIds` |
| `step.completed`       | a step was approved, rejected, skipped, returned, or cancelled | `instance`, `step`                               |
| `instance.returned`    | returned for revision                                          | `instance`, `step`, `toNodeId`                   |
| `approvers.reresolved` | an admin re-resolved approvers                                 | `instance`, `step`, `added`, `removed`           |
| `timeout.escalated`    | an overdue step was escalated                                  | `instance`, `step`, `approvers`                  |
| `instance.completed`   | the instance was approved, rejected, or cancelled              | `instance`                                       |

## Errors

Every error extends `ParafError` and has a `code`. Errors of actions (`ActionError`) also carry a
`context` with the `action`, `instanceId`, `userId`, and, where it applies, `nodeId` and
`groupId`.

| Error                                                              | When                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `FlowValidationError`                                              | `publishFlow` with an invalid flow (`issues` lists every problem)    |
| `FlowNotFoundError`                                                | the flow, or that version, does not exist                            |
| `InstanceNotFoundError`                                            | no instance with that ID                                             |
| `ActiveInstanceExistsError`                                        | the subject already has a running instance                           |
| `DocumentValidationError`                                          | the document does not match the flow's `variables` (`problems`)      |
| `NotAuthorizedError`                                               | the user may not take this action                                    |
| `InvalidStateError`, `InvalidArgumentError`                        | the instance is not in a state for the action, or a bad argument     |
| `ConcurrencyError`                                                 | still conflicting after the retries                                  |
| `DelegationError`                                                  | a delegation would make a group's minimum unreachable                |
| `EmptyApproversError`, `InsufficientApproversError`                | entering a step found nobody, or too few (with the `'error'` policy) |
| `UnknownApproverTypeError`, `UnknownChainError`, `ChainCycleError` | a step uses an unregistered type or chain, or the chain loops        |
| `ConditionEvaluationError`                                         | a condition could not be evaluated                                   |

A failed action changes nothing; when entering a step fails, that is also recorded in the audit
trail (`step_failed`).

## Validate a flow

```ts
import { validateFlow } from '@paraf/core';

const issues = validateFlow(flow, {
  approverTypes: ['role', 'supervisor'], // optional: also check registered types
  chains: ['reporting-line'],
});

for (const issue of issues) {
  console.log(issue.code, issue.path, issue.message);
  // UNKNOWN_NODE_REFERENCE nodes.review.next Node "review": "next" points to node "ghost", which does not exist.
}
```

`validateFlow` returns every problem at once (an empty array means the flow is valid). Each issue
has a `code`, a `path` into the document, a `message`, and `nodeId` / `groupId` when it belongs
to a node or group. `publishFlow` runs it with the engine's registered types, chains, and
operators.

The flow format is also published as a JSON Schema (draft 2020-12), for editors and other
validators. It checks the shape only; references, loops, and condition expressions are checked
by `validateFlow`.

```ts
import { flowSchema } from '@paraf/core';
// or: import schema from '@paraf/core/flow.schema.json' with { type: 'json' };
```

## Storage

`MemoryStore` keeps everything in the process (tests, examples, prototypes). For production use
[`@paraf/postgres`](../postgres/README.md) or [`@paraf/mysql`](../mysql/README.md). To support
another database, implement the `ParafStore` interface; its doc comment lists the contract
(immutable flow versions, atomic writes, one running instance per subject, updates only at the
expected revision).

## API reference

### `createEngine(options)`

| Option         | Default            | Description                                                          |
| -------------- | ------------------ | -------------------------------------------------------------------- |
| `store`        | (required)         | Where flows, instances, and the audit trail are stored.              |
| `isAdmin`      | nobody             | `(userId, { instance }) => boolean`: may cancel, return, re-resolve. |
| `now`          | `() => new Date()` | The clock (also used by `processTimeouts`).                          |
| `generateId`   | UUID v7            | IDs for instances, steps, slots, and audit entries.                  |
| `maxRetries`   | `3`                | Retries of an action after a concurrent update.                      |
| `onEventError` | `console.error`    | Called when an event handler throws.                                 |

### Engine methods

| Method                                                                                           | Returns                                                    |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `registerApproverType(type, resolver, meta?)`                                                    | registers an approver type                                 |
| `registerChain(name, resolver, meta?)`                                                           | registers a chain                                          |
| `registerOperator(name, fn)`                                                                     | registers a condition operator                             |
| `getApproverTypes()`, `getChains()`, `getOperators()`                                            | what is registered (for the editor)                        |
| `publishFlow(flow, { createdBy?, notes? })`                                                      | `PublishedFlow` (the new active version)                   |
| `activateFlowVersion(flowId, version)`                                                           | makes an older version active (rollback)                   |
| `getActiveFlow(flowId)`, `getFlow(flowId, version)`                                              | `PublishedFlow \| null`                                    |
| `listFlows()`                                                                                    | `FlowSummary[]` (active and latest version)                |
| `listFlowVersions(flowId)`                                                                       | `FlowVersionInfo[]`, newest first                          |
| `start(flowId, { subject, requester, document? })`                                               | `Instance`                                                 |
| `approve`, `reject`, `returnForRevision`, `resubmit`, `delegate`, `cancel`, `reresolveApprovers` | `Instance` (see [Actions](#actions-and-who-may-take-them)) |
| `processTimeouts(now?)`                                                                          | `{ escalated, failed }`                                    |
| `getInstance(instanceId)`                                                                        | `InstanceState \| null`: instance, steps, slots            |
| `findInstances({ subject?, status?, flowId?, limit?, offset? })`                                 | `{ items, total }`, newest first                           |
| `findPendingForUser(userId, { limit?, offset? })`                                                | `{ items, total }`: the user's inbox                       |
| `getHistory(instanceId)`                                                                         | `AuditEntry[]`, oldest first                               |
| `on(event, handler)`                                                                             | unsubscribe function                                       |

### Other exports

- `validateFlow`, `flowSchema`, `validateDocument`, `evaluateCondition`
- `parseDuration`, `addDuration` (ISO 8601 durations)
- `MemoryStore`, and the `ParafStore` interface for custom stores
- `uuidv7()` and `createUuidV7Generator()`: RFC 9562 version 7 IDs, time-ordered and strictly
  increasing within a process
- Every type of the flow format (`FlowDefinition`, `FlowNode`, `ApprovalNode`, …) and of the
  runtime (`Instance`, `Step`, `ApproverSlot`, `AuditEntry`, …), and all error classes
