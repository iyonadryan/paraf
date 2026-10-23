# Paraf

**Dynamic approval workflows for JavaScript and TypeScript, with a visual flow editor.**

> _Paraf_ (Indonesian): the initials you sign on a document to approve it.

> [!WARNING]
> Paraf is at `0.x`: the API may still change before `1.0.0`. Changes are listed in each
> package's `CHANGELOG.md`.

Paraf lets you define approval flows as JSON, run them with a headless engine, store them in PostgreSQL or MySQL, and let admins edit them visually with a drag-and-drop editor. It doesn't assume anything about your users, roles, or org chart: you plug in how approvers are found.

## Requirements

| What                                     | Version                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Node.js                                  | **24 or newer**                                                            |
| PostgreSQL (with `@paraf/postgres`)      | 12 or newer (tested on 16), driver `pg` 8.11+                              |
| MySQL (with `@paraf/mysql`)              | 8.0.19 or newer, InnoDB (tested on 8.4), driver `mysql2` 3.9+              |
| React (with `@paraf/editor`)             | 18 or newer                                                                |
| Express, Fastify, or Hono (Paraf Studio) | Only to mount the studio in your app: Express 4.18+, Fastify 5+, Hono 4.8+ |

## Installation

Install the engine, plus the adapter for your database:

```sh
npm install @paraf/core
npm install @paraf/postgres pg     # PostgreSQL
npm install @paraf/mysql mysql2    # or MySQL
```

Optional:

```sh
npm install @paraf/editor react react-dom   # the visual editor, inside your React app
npm install --save-dev @paraf/studio        # Paraf Studio: the editor as a ready-made app
```

Using pnpm or Yarn? Replace `npm install` with `pnpm add` or `yarn add` (and `--save-dev` with
`-D`). Only working on this repository itself needs pnpm; see [Contributing](#contributing).

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
- **Paraf Studio.** The editor as a ready-made app next to yours (own port, or Express, Fastify, Hono): publish to your database, see the version history, roll back.
- **Safe by design.** No `eval`: conditions use a JSON Logic-style evaluator. Optimistic locking prevents race conditions when approvers act at the same time.

## Packages

| Package           | Description                                    |
| ----------------- | ---------------------------------------------- |
| `@paraf/core`     | Engine, types, flow validator, in-memory store |
| `@paraf/postgres` | PostgreSQL storage adapter                     |
| `@paraf/mysql`    | MySQL storage adapter                          |
| `@paraf/editor`   | React visual flow editor                       |
| `@paraf/studio`   | The editor as a ready-made web app             |

## Quick look

```ts
import { createEngine } from '@paraf/core';
import { PostgresStore } from '@paraf/postgres';

const store = new PostgresStore(pool);
await store.migrate(); // creates the paraf_* tables
const engine = createEngine({ store });

// Tell Paraf how to find approvers in YOUR app
engine.registerApproverType('role', async ({ value }) => {
  const roles = Array.isArray(value) ? value : [value];
  return db.users.findIdsByRoles(roles);
});
engine.registerApproverType('supervisor', async ({ level }, { requester }) =>
  db.users.findManagerIds(requester.id, Number(level ?? 1)),
);

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

Edit flows visually with Paraf Studio, which publishes through the same engine (and so to the
same database). It is off in production by default:

```ts
import { startStudio } from '@paraf/studio';

if (process.env.NODE_ENV !== 'production') {
  await startStudio({ engine, label: 'development' }); // prints http://localhost:7272/?token=…
}
```

See [`@paraf/studio`](./packages/studio/README.md) for mounting it in Express, Fastify, or Hono,
and for editing the flows of staging or production safely.

## Documentation

- [`@paraf/core`](./packages/core/README.md): concepts, approver resolvers (role, group,
  supervisor), modes, parallel groups and reject policies with examples, approval chains,
  conditions, linking approvals to your tables, actions, timeouts, events, errors, and the API
  reference.
- [`@paraf/postgres`](./packages/postgres/README.md) and [`@paraf/mysql`](./packages/mysql/README.md):
  setup, migrations, and a diagram of the tables.
- [`@paraf/editor`](./packages/editor/README.md): the React editor and the progress view.
- [`@paraf/studio`](./packages/studio/README.md): Paraf Studio.

## Examples

| Example                                           | Shows                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| [`basic-node`](./examples/basic-node)             | The engine in a Node.js script, in memory: resolvers, a chain, events    |
| [`express-postgres`](./examples/express-postgres) | An Express API on PostgreSQL: your tables, subjects, inbox, Paraf Studio |
| [`editor-demo`](./examples/editor-demo)           | The editor and the progress view in a Vite app                           |
| [`studio-demo`](./examples/studio-demo)           | Paraf Studio on its own port                                             |

## Roadmap

- [x] Foundation: monorepo, flow schema, validator, UUID v7
- [x] Core engine: approvers, modes, groups, actions, versioning, audit, events
- [x] Approval chains and duplicate approver handling
- [x] Timeouts and escalation
- [x] PostgreSQL and MySQL adapters
- [x] Visual editor and progress view
- [x] Paraf Studio (own port, Express, Fastify, Hono), version history and rollback
- [x] Docs and first release (`0.1.0`)

## Contributing

Issues and ideas are welcome. Contribution guidelines will be added once the core API stabilizes.

Development needs Node.js 24 (see `.node-version`) and pnpm (`corepack enable pnpm`):

```sh
pnpm install
docker compose up -d --wait   # PostgreSQL 16 and MySQL 8.4 for the adapter tests
pnpm lint && pnpm typecheck && pnpm test
pnpm changeset   # describe changes to published packages
```

The adapter tests read `PARAF_POSTGRES_URL` and `PARAF_MYSQL_URL`, defaulting to the
`docker-compose.yml` databases (ports 55432 and 53306).

The editor demo runs a real engine on a `MemoryStore` in the browser:

```sh
pnpm --filter editor-demo dev                                # http://localhost:5199
```

The studio demo starts Paraf Studio with an in-memory engine and a sample flow:

```sh
pnpm build                          # the studio serves its built UI
pnpm --filter studio-demo start     # prints http://localhost:7272/?token=…
```

End-to-end tests (Playwright) for both demos:

```sh
pnpm --filter editor-demo exec playwright install chromium   # once
pnpm build && pnpm test:e2e
```

### Releasing

Versions and changelogs are managed with [Changesets](https://github.com/changesets/changesets):

```sh
pnpm changeset            # with each change: pick the packages and the SemVer bump
pnpm version-packages     # bump versions and write the CHANGELOG.md files
pnpm release              # build, then publish to npm (needs `npm login` with access to @paraf)
```

Publish through pnpm (as `pnpm release` does), not `npm publish`: pnpm replaces the
`workspace:` version ranges between the packages with real ones.

## License

[MIT](./LICENSE)
