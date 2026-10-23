# Paraf

**Dynamic approval workflows for JavaScript and TypeScript, with a visual flow editor.**

> *Paraf* (Indonesian): the initials you sign on a document to approve it.

> [!WARNING]
> Paraf is in early development. The API is not stable yet and packages are not published to npm. Follow the [roadmap](#roadmap) for progress.

Paraf lets you define approval flows as JSON, run them with a headless engine, store them in PostgreSQL or MySQL, and let admins edit them visually with a drag-and-drop editor. It doesn't assume anything about your users, roles, or org chart: you plug in how approvers are found.

## Features

- **Flows as data.** Approval flows are versioned JSON documents. Editing a flow creates a new version; running approvals keep the version they started with.
- **Dynamic approvers.** Approvers by user, role, group, supervisor, a field on the document, or any custom resolver you register.
- **Flexible rules per step.** `any`, `all`, or `minimum: n` approvals, with configurable reject policies and handling for empty or insufficient approver lists.
- **Parallel groups.** "At least 1 manager **and** at least 2 from finance" in a single step.
- **Multi-level approvals.** Chain steps one after another, branch on conditions (amount, department, ...), or walk up the supervisor chain until a director is reached.
- **Real-world actions.** Approve, reject, return for revision, resubmit, delegate, cancel, timeout and escalation.
- **Audit trail.** Every decision is recorded: who, what, when, and why.
- **Database-agnostic core.** Zero runtime dependencies. Adapters for PostgreSQL and MySQL, or write your own.
- **Visual editor.** A React component for building flows like a diagram, with live validation.
- **Safe by design.** No `eval`: conditions use a JSON Logic-style evaluator. Optimistic locking prevents race conditions when approvers act at the same time.

## Packages

| Package | Description |
|---|---|
| `@paraf/core` | Engine, types, flow validator, in-memory store |
| `@paraf/postgres` | PostgreSQL storage adapter |
| `@paraf/mysql` | MySQL storage adapter |
| `@paraf/editor` | React visual flow editor |

## Quick look

> Planned API. Subject to change before `1.0.0`.

```ts
import { createEngine } from '@paraf/core';
import { PostgresStore } from '@paraf/postgres';

const engine = createEngine({ store: new PostgresStore(pool) });

// Tell Paraf how to find approvers in YOUR app
engine.registerApproverType('role', async ({ value }) => {
  const roles = Array.isArray(value) ? value : [value];
  return db.users.findIdsByRoles(roles);
});

// Publish a flow: supervisor first, then director
await engine.publishFlow({
  id: 'purchase-request',
  name: 'Purchase Request',
  start: 'supervisor',
  nodes: {
    supervisor: {
      type: 'approval',
      approvers: [{ type: 'supervisor', level: 1 }],
      mode: 'any',
      next: 'director',
      onReject: 'rejected',
    },
    director: {
      type: 'approval',
      approvers: [{ type: 'role', value: 'director' }],
      mode: 'all',
      next: 'approved',
      onReject: 'rejected',
    },
    approved: { type: 'end', result: 'approved' },
    rejected: { type: 'end', result: 'rejected' },
  },
});

// Start an approval for one of your documents
const instance = await engine.start('purchase-request', {
  subject: { type: 'purchase_request', id: '42' },
  requester: { id: 'u7' },
  document: { amount: 15_000_000 },
});

await engine.approve(instance.id, 'u12', 'Looks good');

// React to changes (send notifications, update your own tables, ...)
engine.on('instance.completed', async ({ instance }) => {
  await db.purchaseRequests.update(instance.subject.id, { status: instance.status });
});
```

## Roadmap

- [ ] Foundation: monorepo, flow schema, validator, UUID v7
- [ ] Core engine: approvers, modes, groups, actions, versioning, audit, events
- [ ] Approval chains and duplicate approver handling
- [ ] Timeouts and escalation
- [ ] PostgreSQL and MySQL adapters
- [ ] Visual editor
- [ ] Docs and first release (`0.1.0`)

## Contributing

Issues and ideas are welcome. Contribution guidelines will be added once the core API stabilizes.

## License

[MIT](./LICENSE)
