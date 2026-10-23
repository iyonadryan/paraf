# Example: Paraf Studio

Paraf Studio on its own port, with an in-memory engine and a sample flow.

```sh
pnpm install
pnpm build                        # the studio serves its built UI
pnpm --filter studio-demo start   # open the printed http://localhost:7272/?token=… link
```

`pnpm --filter studio-demo test:e2e` checks the token lock, publishing with notes, rollback, and
creating a flow, with Playwright.
