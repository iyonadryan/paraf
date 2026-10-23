# @paraf/core

Headless approval workflow engine for [Paraf](../../README.md): the engine, flow definition
types, JSON Schema, flow validator, in-memory store, and UUID v7 generator. Zero runtime
dependencies.

> [!WARNING]
> Early development. Approval chains, duplicate approver handling, and timeouts are not
> available yet.

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

Other actions: `reject`, `returnForRevision`, `resubmit`, `delegate`, `cancel`, and
`reresolveApprovers`. Queries: `getInstance`, `findInstances({ subject })`,
`findPendingForUser` (inbox), and `getHistory` (audit trail).

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
