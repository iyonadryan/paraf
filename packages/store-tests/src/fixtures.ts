import { uuidv7 } from '@paraf/core';
import type {
  ApproverSlot,
  AuditEntry,
  Instance,
  InstanceState,
  PublishedFlow,
  Step,
} from '@paraf/core';

export const FLOW_ID = 'purchase-request';

/** A flow version to satisfy foreign keys; tests do not run it. */
export function flowVersion(version = 1, overrides: Partial<PublishedFlow> = {}): PublishedFlow {
  return {
    id: FLOW_ID,
    version,
    name: 'Pengajuan Pembelian — ✓',
    start: 'supervisor',
    resubmitPolicy: 'restart',
    nodes: {
      supervisor: {
        type: 'approval',
        label: 'Atasan',
        approvers: [{ type: 'role', value: ['finance', 'accounting'] }],
        mode: { minimum: 2 },
        timeout: { after: 'P3D', action: 'escalate', to: [{ type: 'user', value: 'u9' }] },
        next: 'approved',
        onReject: 'rejected',
      },
      approved: { type: 'end', result: 'approved' },
      rejected: { type: 'end', result: 'rejected' },
    },
    layout: { supervisor: { x: 100.5, y: -80 } },
    ...overrides,
  };
}

/** Milliseconds after 2026-01-05T08:00:00.000Z. */
export function time(ms: number): Date {
  return new Date(Date.UTC(2026, 0, 5, 8) + ms);
}

export interface StateOptions {
  subject?: { type: string; id: string };
  status?: Instance['status'];
  createdAt?: Date;
  /** Due date of the active step. */
  dueAt?: Date | null;
  /** Users with a pending slot in the active step, as `[userId, groupId]`. */
  pending?: [string, string][];
}

/**
 * A realistic instance: one approved step (with a delegated and an auto-approved slot) and one
 * active step (an approval-chain level with a due date and pending approvers).
 */
export function instanceState(options: StateOptions = {}): InstanceState {
  const id = uuidv7();
  const createdAt = options.createdAt ?? time(0);
  const done: Step = {
    id: uuidv7(),
    instanceId: id,
    nodeId: 'supervisor',
    iteration: 1,
    chainLevel: 0,
    round: 1,
    status: 'approved',
    config: {
      require: { minimum: 1 },
      countAcrossGroups: false,
      groups: [
        {
          id: 'fin',
          label: 'Finance',
          mode: { minimum: 3 },
          minimum: 2,
          rejectPolicy: { minimum: 2 },
          excludeRequester: true,
          status: 'approved',
        },
      ],
    },
    enteredAt: createdAt,
    dueAt: null,
    completedAt: time(1_234),
  };
  const active: Step = {
    id: uuidv7(),
    instanceId: id,
    nodeId: 'supervisor',
    iteration: 2,
    chainLevel: 1,
    round: 2,
    status: 'active',
    config: {
      require: 'all',
      countAcrossGroups: true,
      groups: [
        {
          id: 'default',
          mode: 'any',
          rejectPolicy: 'any',
          excludeRequester: false,
          status: 'pending',
        },
      ],
      chain: { fromUserId: 'u7', userId: 's1', stopper: false },
    },
    enteredAt: time(2_000),
    dueAt: options.dueAt === undefined ? time(3 * 86_400_000) : options.dueAt,
    completedAt: null,
  };
  const slot = (
    step: Step,
    userId: string,
    groupId: string,
    extra: Partial<ApproverSlot> = {},
  ) => ({
    id: uuidv7(),
    stepId: step.id,
    instanceId: id,
    groupId,
    userId,
    source: { type: 'role', value: ['finance', 'accounting'] },
    status: 'pending' as const,
    delegatedFrom: null,
    autoFromStep: null,
    decidedAt: null,
    comment: null,
    ...extra,
  });
  const status = options.status ?? 'in_progress';
  return {
    instance: {
      id,
      flowId: FLOW_ID,
      flowVersion: 1,
      subject: options.subject ?? { type: 'purchase_request', id: 'PR/2026/10/007' },
      requesterId: 'u7',
      status,
      currentStepId: active.id,
      round: 2,
      document: {
        amount: 15_000_000,
        items: [{ price: 1.5, tags: ['a', 'b'] }],
        note: 'Ünïcødé ✓',
        empty: null,
      },
      revision: 0,
      createdAt,
      updatedAt: createdAt,
      completedAt: ['approved', 'rejected', 'cancelled'].includes(status) ? time(9_000) : null,
    },
    steps: [done, active],
    approvers: [
      slot(done, 'f1', 'fin', { status: 'approved', decidedAt: time(1_000), comment: 'OK 👍' }),
      slot(done, 'f2', 'fin', { status: 'delegated' }),
      slot(done, 'x1', 'fin', {
        status: 'approved',
        delegatedFrom: 'f2',
        decidedAt: time(1_100),
        source: null,
      }),
      slot(done, 'f3', 'fin', { status: 'skipped' }),
      slot(done, 'f4', 'fin', { status: 'approved', autoFromStep: done.id, decidedAt: time(0) }),
      ...(options.pending ?? [['s1', 'default']]).map(([userId, groupId]) =>
        slot(active, userId, groupId, { source: { type: 'chain', chain: 'supervisor', level: 1 } }),
      ),
    ],
  };
}

/** An audit entry for `instanceId`. */
export function auditEntry(instanceId: string, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: uuidv7(),
    instanceId,
    stepId: null,
    nodeId: null,
    action: 'started',
    actorId: null,
    comment: null,
    timestamp: time(0),
    metadata: null,
    ...overrides,
  };
}
