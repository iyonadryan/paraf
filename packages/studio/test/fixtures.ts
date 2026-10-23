import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine, MemoryStore } from '@paraf/core';
import type { FlowDefinition } from '@paraf/core';
import { createStudioHandler } from '../src/handler';
import type { StudioOptions } from '../src/handler';

/** A small UI build for tests, so they do not depend on `vite build`. */
// Without `new URL`: in jsdom tests the global URL is jsdom's, which fileURLToPath rejects.
export const UI_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'ui-fixture');

/** An engine with a `role` type (lazily loaded options), a chain, and an operator. */
export function createTestEngine(store = new MemoryStore()) {
  const engine = createEngine({ store });
  engine.registerApproverType('role', () => ['m1'], {
    label: 'Role',
    configSchema: {
      value: {
        type: 'multiselect',
        label: 'Roles',
        options: () => Promise.resolve([{ value: 'manager', label: 'Manager' }]),
      },
      note: { type: 'text', label: 'Note' },
    },
  });
  engine.registerApproverType('everyone', () => ['m1', 'm2']);
  engine.registerChain('supervisor', () => null, { label: 'Reporting' });
  engine.registerOperator('startsWith', ([text, prefix]) =>
    String(text).startsWith(String(prefix)),
  );
  return engine;
}

/** A valid flow with one approval step. */
export function sampleFlow(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    id: 'purchase-request',
    name: 'Purchase request',
    start: 'manager',
    nodes: {
      manager: {
        type: 'approval',
        label: 'Manager',
        approvers: [{ type: 'role', value: 'manager' }],
        mode: 'any',
        next: 'approved',
        onReject: 'rejected',
      },
      approved: { type: 'end', result: 'approved' },
      rejected: { type: 'end', result: 'rejected' },
    },
    ...overrides,
  };
}

/** A handler on a fresh engine (with `sampleFlow` published once) and the fixture UI. */
export async function setupHandler(options: Partial<StudioOptions> = {}) {
  const engine = options.engine ?? createTestEngine();
  if (!options.engine)
    await engine.publishFlow(sampleFlow(), { createdBy: 'seed', notes: 'First' });
  const handler = createStudioHandler({ ...options, engine, uiDir: UI_FIXTURE });
  const base = 'http://localhost/paraf';
  const call = (
    path: string,
    init: RequestInit = {},
    user: { id: string } | null = { id: 'dev-1' },
  ) => handler(new Request(`${base}${path}`, init), { path, user });
  const post = (path: string, body: unknown, user: { id: string } | null = { id: 'dev-1' }) =>
    call(
      path,
      {
        method: 'POST',
        headers: { 'x-paraf-studio': '1', 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      user,
    );
  return { engine, handler, call, post };
}
