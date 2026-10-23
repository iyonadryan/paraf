import { createEngine, MemoryStore } from '../../src';
import type {
  EngineOptions,
  FlowDefinition,
  InstanceState,
  ParafEngine,
  ParafEventName,
  ParafEvents,
} from '../../src';

export const END_NODES = {
  approved: { type: 'end', result: 'approved' },
  rejected: { type: 'end', result: 'rejected' },
} as const;

/** A flow with a single approval node `step` built from `node`. */
export function singleStepFlow(node: Record<string, unknown>, id = 'single'): FlowDefinition {
  return {
    id,
    name: 'Single step',
    start: 'step',
    nodes: {
      step: { type: 'approval', next: 'approved', onReject: 'rejected', ...node },
      ...END_NODES,
    },
  } as unknown as FlowDefinition;
}

/** Supervisor first, then all directors. */
export const twoLevelFlow = {
  id: 'two-level',
  name: 'Two levels',
  start: 'supervisor',
  nodes: {
    supervisor: {
      type: 'approval',
      label: 'Supervisor',
      approvers: [{ type: 'supervisor', level: 1 }],
      mode: 'any',
      next: 'director',
      onReject: 'rejected',
    },
    director: {
      type: 'approval',
      label: 'Director',
      approvers: [{ type: 'role', value: 'director' }],
      mode: 'any',
      next: 'approved',
      onReject: 'rejected',
    },
    ...END_NODES,
  },
} satisfies FlowDefinition;

const EVENT_NAMES: ParafEventName[] = [
  'instance.created',
  'step.entered',
  'approval.required',
  'step.completed',
  'instance.completed',
  'instance.returned',
  'approvers.reresolved',
  'timeout.escalated',
];

export interface RecordedEvent<E extends ParafEventName = ParafEventName> {
  name: E;
  payload: ParafEvents[E];
}

/**
 * An engine on a MemoryStore with a small org chart:
 * - roles: manager m1 m2, director d1 d2, ceo ceo1, finance f1 f2 f3, accounting a1 f1,
 *   committee c1..c4;
 * - supervisors: u7 → s1 → m1 → d1 → ceo1.
 * The user `admin` is an admin.
 */
export function setup(options: Partial<EngineOptions> = {}) {
  const store = new MemoryStore();
  let clock = new Date('2026-01-05T08:00:00.000Z');
  const roles: Record<string, string[]> = {
    manager: ['m1', 'm2'],
    director: ['d1', 'd2'],
    ceo: ['ceo1'],
    finance: ['f1', 'f2', 'f3'],
    accounting: ['a1', 'f1'],
    committee: ['c1', 'c2', 'c3', 'c4'],
  };
  const supervisors: Record<string, string | undefined> = {
    u7: 's1',
    s1: 'm1',
    m1: 'd1',
    d1: 'ceo1',
  };

  const engine = createEngine({
    store,
    now: () => new Date(clock),
    isAdmin: (userId) => userId === 'admin',
    ...options,
  });
  engine.registerApproverType(
    'role',
    ({ value }) =>
      (Array.isArray(value) ? value : [value]).flatMap((role) =>
        typeof role === 'string' ? (roles[role] ?? []) : [],
      ),
    { label: 'By role', configSchema: { value: { type: 'multiselect', label: 'Role' } } },
  );
  engine.registerApproverType('supervisor', ({ level }, context) => {
    let current: string | undefined = context.requester.id;
    for (let i = 0; i < Number(level ?? 1) && current !== undefined; i++) {
      current = supervisors[current];
    }
    return current === undefined ? [] : [current];
  });

  engine.registerChain('supervisor', (fromUserId) => supervisors[fromUserId] ?? null, {
    label: 'Supervisors',
  });

  const events: RecordedEvent[] = [];
  for (const name of EVENT_NAMES) {
    engine.on(name, (payload) => {
      events.push({ name, payload });
    });
  }

  const helpers = {
    engine,
    store,
    roles,
    supervisors,
    events,
    /** Moves the clock forward. */
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    async publish(flow: FlowDefinition) {
      return engine.publishFlow(flow);
    },
    /** Publishes `flow` and starts it for `subject` (default `doc:1`). */
    async run(
      flow: FlowDefinition,
      {
        requester = 'u7',
        subjectId = '1',
        document = {},
      }: { requester?: string; subjectId?: string; document?: Record<string, never> | object } = {},
    ) {
      if (!(await engine.getActiveFlow(flow.id))) await engine.publishFlow(flow);
      return engine.start(flow.id, {
        subject: { type: 'doc', id: subjectId },
        requester: { id: requester },
        document: document as never,
      });
    },
    async state(instanceId: string): Promise<InstanceState> {
      const state = await engine.getInstance(instanceId);
      if (!state) throw new Error(`no instance ${instanceId}`);
      return state;
    },
    /** Status of each slot of the active (or last) step as `user:status`, per group. */
    async slots(instanceId: string, stepIndex = -1): Promise<Record<string, string[]>> {
      const state = await helpers.state(instanceId);
      const step = state.steps.slice(stepIndex)[0];
      const result: Record<string, string[]> = {};
      for (const slot of state.approvers.filter((s) => s.stepId === step?.id)) {
        (result[slot.groupId] ??= []).push(`${slot.userId}:${slot.status}`);
      }
      return result;
    },
    /** Node of the active step, or `null`. */
    async activeNode(instanceId: string): Promise<string | null> {
      const state = await helpers.state(instanceId);
      return state.steps.find((step) => step.id === state.instance.currentStepId)?.nodeId ?? null;
    },
    async actions(instanceId: string): Promise<string[]> {
      return (await engine.getHistory(instanceId)).map((entry) => entry.action);
    },
    eventNames(): string[] {
      return events.map((event) => event.name);
    },
  };
  return helpers;
}

export type Setup = ReturnType<typeof setup>;
export type { ParafEngine };
