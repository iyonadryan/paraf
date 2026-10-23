import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Use the packages' sources directly, so the demo needs no build step.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@paraf\/core$/, replacement: source('../../packages/core/src/index.ts') },
      { find: /^@paraf\/editor$/, replacement: source('../../packages/editor/src/index.ts') },
      {
        find: /^@paraf\/editor\/style\.css$/,
        replacement: source('../../packages/editor/src/styles.css'),
      },
    ],
  },
  server: { port: 5199, strictPort: true },
});
