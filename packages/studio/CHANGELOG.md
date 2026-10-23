# @paraf/studio

## 0.1.0

### Minor Changes

- First release.

  - `@paraf/core`: the headless engine. JSON flow definitions with approval, approval-chain,
    condition, and end nodes; pluggable approver resolvers and chains; modes `any`, `all`, and
    `{ minimum: n }`; parallel groups with `require` and `countAcrossGroups`; reject policies;
    empty and insufficient approver handling; duplicate approver handling; approve, reject,
    return for revision, resubmit, delegate, cancel, and re-resolve; timeouts with escalation;
    document variables; flow versioning with release notes and rollback; optimistic locking;
    audit trail; events; `validateFlow` and a JSON Schema; `MemoryStore`; UUID v7.
  - `@paraf/postgres` and `@paraf/mysql`: storage adapters with migrations.
  - `@paraf/editor`: the React flow editor and the progress view.
  - `@paraf/studio`: Paraf Studio, on its own port or mounted in Express, Fastify, or Hono.

### Patch Changes

- Updated dependencies
  - @paraf/core@0.1.0
