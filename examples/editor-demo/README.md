# Example: editor demo

A Vite app with `<ParafEditor>` and `<ParafProgress>` on a real engine running in the browser
(`MemoryStore`). Switch between English and Indonesian, publish a flow, submit a document, and
approve it to see the progress view.

```sh
pnpm install
pnpm --filter editor-demo dev     # http://localhost:5199
```

`pnpm --filter editor-demo test:e2e` builds the specification's example flow through the UI with
Playwright, exports it, and imports it again.
