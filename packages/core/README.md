# @paraf/core

Headless approval workflow engine for [Paraf](../../README.md): the engine, flow definition
types, JSON Schema, flow validator, in-memory store, and UUID v7 generator. Zero runtime
dependencies.

> [!WARNING]
> Early development. The API may still change before `1.0.0`.

Requires Node.js 24 or newer.

```sh
npm install @paraf/core
```

## Run a flow

```ts
import { createEngine, MemoryStore } from '@paraf/core';

const engine = createEngine({
  store: new MemoryStore(),
  isAdmin: (userId) => admins.includes(userId), // may cancel, re-resolve, return
});

engine.registerApproverType('role', ({ value }) => usersWithRoles(value));
await engine.publishFlow(flow); // validated, stored as a new version, made active

const instance = await engine.start('purchase-request', {
  subject: { type: 'purchase_request', id: '42' },
  requester: { id: 'u7' },
  document: { amount: 15_000_000 },
});

engine.on('approval.required', ({ groups }) => notify(groups.flatMap((g) => g.userIds)));
await engine.approve(instance.id, 'u12', 'Looks good');
```

For "walk up the supervisors until a director", register a chain and use an `approval-chain`
node (`{ type: 'approval-chain', chain: 'supervisor', until: { type: 'role', value: 'director' },
maxLevels: 5, ... }`):

```ts
engine.registerChain('supervisor', (userId) => supervisorOf(userId) ?? null);
```

Timeouts (`timeout: { after: 'P3D', action: 'escalate', to: [...] }`) set a `dueAt` on each
step. The engine runs no timers; call `processTimeouts` from your scheduler. An escalated step
can then be decided by any one of the `to` approvers.

```ts
cron.schedule('*/5 * * * *', () => engine.processTimeouts());
```

Other actions: `reject`, `returnForRevision`, `resubmit`, `delegate`, `cancel`, and
`reresolveApprovers`. Queries: `getInstance`, `findInstances({ subject })`,
`findPendingForUser` (inbox), and `getHistory` (audit trail).

Every `publishFlow` stores a new, immutable version and makes it active; instances keep the
version they started with. Record who published it and why, list the history, and roll back:

```ts
await engine.publishFlow(flow, { createdBy: 'dev-1', notes: 'Finance approves above 10M' });
await engine.listFlowVersions('purchase-request'); // newest first: version, name, createdBy, notes, createdAt
await engine.activateFlowVersion('purchase-request', 2);
```

[Paraf Studio](../studio/README.md) does all of this in the browser.

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

## Validate a flow

```ts
import { validateFlow } from '@paraf/core';

const issues = validateFlow(flow, {
  approverTypes: ['role', 'supervisor'], // optional: also check registered types
  chains: ['supervisor'],
});

for (const issue of issues) {
  console.log(issue.code, issue.path, issue.message);
  // UNKNOWN_NODE_REFERENCE nodes.review.next Node "review": "next" points to node "ghost", which does not exist.
}
```

`validateFlow` returns every problem at once (an empty array means the flow is valid). Each issue
has a `code`, a `path` into the document, a `message`, and `nodeId` / `groupId` when it belongs
to a node or group.

## JSON Schema

The flow format is also published as a JSON Schema (draft 2020-12), for editors and other
validators. The schema checks the shape only; references between nodes, loops, and condition
expressions are checked by `validateFlow`.

```ts
import { flowSchema } from '@paraf/core';
// or: import schema from '@paraf/core/flow.schema.json' with { type: 'json' };
```

## UUID v7

```ts
import { uuidv7 } from '@paraf/core';

uuidv7(); // '019a10a3-5e2b-7c41-8f0e-3a9d2b6c4e17'
```

IDs are RFC 9562 version 7: time-ordered, and strictly increasing within a process (also for IDs
created in the same millisecond).
