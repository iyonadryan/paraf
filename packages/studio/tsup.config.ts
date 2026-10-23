import { defineConfig } from 'tsup';

// The server side. The UI is built by Vite into dist/ui (see vite.config.ts), after this.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    express: 'src/express.ts',
    fastify: 'src/fastify.ts',
    hono: 'src/hono.ts',
  },
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
  // `import.meta.url` (used to find dist/ui) in the CommonJS build.
  shims: true,
  tsconfig: 'tsconfig.build.json',
});
