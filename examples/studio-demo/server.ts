// Paraf Studio on its own port, as you would start it next to your app in development.
// Here the engine uses a MemoryStore with a sample flow; in your app, pass the engine that uses
// your database (e.g. `new PostgresStore(pool)` with DATABASE_URL from .env).
//
//   pnpm --filter @paraf/studio build && pnpm --filter studio-demo start
import { createEngine, MemoryStore } from '@paraf/core';
import { startStudio } from '@paraf/studio';

const roles: Record<string, string[]> = {
  manager: ['m1', 'm2'],
  director: ['d1'],
  finance: ['f1', 'f2', 'f3'],
};
const supervisors: Record<string, string | undefined> = { u7: 's1', s1: 'm1', m1: 'd1' };

const engine = createEngine({ store: new MemoryStore() });

engine.registerApproverType(
  'role',
  ({ value }) =>
    (Array.isArray(value) ? value : [value]).flatMap((role) =>
      typeof role === 'string' ? (roles[role] ?? []) : [],
    ),
  {
    label: 'Role',
    description: 'Everyone with a given role',
    configSchema: {
      value: {
        type: 'multiselect',
        label: 'Roles',
        required: true,
        options: () => Object.keys(roles).map((role) => ({ value: role, label: role })),
      },
    },
  },
);
engine.registerApproverType(
  'supervisor',
  ({ level }, context) => {
    let current: string | undefined = context.requester.id;
    for (let i = 0; i < Number(level ?? 1) && current !== undefined; i++) {
      current = supervisors[current];
    }
    return current === undefined ? [] : [current];
  },
  {
    label: 'Manager',
    description: "The requester's manager, level 1, 2, ...",
    configSchema: { level: { type: 'number', label: 'Level', required: true } },
  },
);
engine.registerChain('supervisor', (userId) => supervisors[userId] ?? null, {
  label: 'Reporting',
});

await engine.publishFlow(
  {
    id: 'purchase-request',
    name: 'Purchase request',
    start: 'manager',
    nodes: {
      manager: {
        type: 'approval',
        label: 'Manager',
        approvers: [{ type: 'supervisor', level: 1 }],
        mode: 'any',
        next: 'approved',
        onReject: 'rejected',
      },
      approved: { type: 'end', result: 'approved' },
      rejected: { type: 'end', result: 'rejected' },
    },
  },
  { createdBy: 'seed', notes: 'First version' },
);

await startStudio({
  engine,
  label: process.env.STUDIO_LABEL ?? 'demo (in memory)',
  ...(process.env.PORT ? { port: Number(process.env.PORT) } : {}),
});
