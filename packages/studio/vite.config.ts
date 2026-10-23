import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Aliases to the workspace sources, shared with vitest.config.ts. */
export const aliases = [
  { find: /^@paraf\/core$/, replacement: source('../core/src/index.ts') },
  { find: /^@paraf\/editor$/, replacement: source('../editor/src/index.ts') },
  { find: /^@paraf\/editor\/style\.css$/, replacement: source('../editor/src/styles.css') },
];

// The studio UI: a single page served by the studio server. Relative URLs (`base: './'`) let it
// work wherever the studio is mounted.
export default defineConfig({
  root: 'ui',
  base: './',
  plugins: [react()],
  resolve: { alias: aliases },
  // One bundle (React, React Flow, the editor) for a tool served locally.
  build: { outDir: '../dist/ui', emptyOutDir: true, chunkSizeWarningLimit: 700 },
});
