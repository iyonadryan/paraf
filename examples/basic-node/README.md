# Example: basic Node.js

The Paraf engine in a plain Node.js script with a `MemoryStore`: approver types (`role`,
`supervisor`), a chain, events, and one purchase request from submission to approval.

```sh
pnpm install
pnpm --filter @paraf/core build
pnpm --filter basic-node start
```

Read [`index.ts`](./index.ts) from top to bottom: organisation data, engine, flow, request.
