import { createEngine, MemoryStore } from '@paraf/core';

/** A tiny organisation for the demo. */
export const directory = {
  roles: {
    manager: ['m1', 'm2'],
    director: ['d1'],
    finance: ['f1', 'f2', 'f3'],
    accounting: ['a1'],
  } as Record<string, string[]>,
  supervisors: { u7: 's1', s1: 'm1', m1: 'd1' } as Record<string, string | undefined>,
  names: {
    u7: 'Dimas Pratama',
    s1: 'Rina Hapsari',
    m1: 'Budi Santoso',
    m2: 'Maya Lestari',
    d1: 'Sari Wulandari',
    f1: 'Fajar Nugroho',
    f2: 'Tika Ramadhani',
    f3: 'Andi Wijaya',
    a1: 'Lina Kusuma',
  } as Record<string, string | undefined>,
};

/**
 * A real engine running in the browser on a MemoryStore, so publishing and the progress view
 * work in the demo. In an app the engine runs on your server; send `getApproverTypes()` and
 * `getChains()` to the browser for the editor.
 */
export const engine = createEngine({ store: new MemoryStore() });

engine.registerApproverType(
  'role',
  ({ value }) =>
    (Array.isArray(value) ? value : [value]).flatMap((role) =>
      typeof role === 'string' ? (directory.roles[role] ?? []) : [],
    ),
  {
    label: 'Role',
    description: 'Everyone with a given role',
    configSchema: {
      value: {
        type: 'multiselect',
        label: 'Roles',
        required: true,
        options: () =>
          Promise.resolve(
            Object.keys(directory.roles).map((role) => ({ value: role, label: role })),
          ),
      },
    },
  },
);

engine.registerApproverType(
  'supervisor',
  ({ level }, context) => {
    let current: string | undefined = context.requester.id;
    for (let i = 0; i < Number(level ?? 1) && current !== undefined; i++) {
      current = directory.supervisors[current];
    }
    return current === undefined ? [] : [current];
  },
  {
    label: 'Manager',
    description: "The requester's manager, level 1, 2, ...",
    configSchema: { level: { type: 'number', label: 'Level', required: true } },
  },
);

engine.registerChain('supervisor', (userId) => directory.supervisors[userId] ?? null, {
  label: 'Reporting',
});

export const approverTypes = engine.getApproverTypes();
export const chains = engine.getChains();
