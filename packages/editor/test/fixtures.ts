import { createEngine, MemoryStore } from '@paraf/core';
import type { ApproverTypeInfo, ChainInfo, FlowDefinition } from '@paraf/core';

/** The example flow from section 1 of the specification. */
export function specFlow(): FlowDefinition {
  return {
    id: 'purchase-request',
    name: 'Pengajuan Pembelian',
    start: 'supervisor',
    resubmitPolicy: 'restart',
    nodes: {
      supervisor: {
        type: 'approval',
        label: 'Atasan Langsung',
        approvers: [{ type: 'supervisor', level: 1 }],
        mode: 'any',
        excludeRequester: true,
        onEmptyApprovers: 'skip',
        timeout: { after: 'P3D', action: 'escalate', to: [{ type: 'supervisor', level: 2 }] },
        next: 'checkAmount',
        onReject: 'end_rejected',
      },
      checkAmount: {
        type: 'condition',
        rules: [{ when: { '>': [{ var: 'amount' }, 10000000] }, next: 'chain' }],
        else: 'review',
      },
      chain: {
        type: 'approval-chain',
        label: 'Naik sampai Direktur',
        chain: 'supervisor',
        from: 'requester',
        until: { type: 'role', value: 'director' },
        includeStopper: true,
        maxLevels: 5,
        duplicateApprover: 'auto-approve',
        next: 'review',
        onReject: 'end_rejected',
      },
      review: {
        type: 'approval',
        label: 'Manager & Finance (paralel)',
        groups: [
          {
            id: 'mgr',
            label: 'Manager',
            approvers: [{ type: 'role', value: 'manager' }],
            mode: 'any',
          },
          {
            id: 'fin',
            label: 'Finance',
            approvers: [{ type: 'role', value: ['finance', 'accounting'] }],
            mode: { minimum: 2 },
            rejectPolicy: 'impossible',
            onInsufficientApprovers: 'cap',
          },
        ],
        require: 'all',
        duplicateApprover: 'require',
        next: 'end_approved',
        onReject: 'end_rejected',
      },
      end_approved: { type: 'end', result: 'approved' },
      end_rejected: { type: 'end', result: 'rejected' },
    },
  };
}

const roles: Record<string, string[]> = {
  manager: ['m1', 'm2'],
  director: ['d1'],
  finance: ['f1', 'f2', 'f3'],
  accounting: ['a1'],
};
const supervisors: Record<string, string | undefined> = { u7: 's1', s1: 'm1', m1: 'd1' };

/** An engine on a MemoryStore with the `role` and `supervisor` types and the `supervisor` chain. */
export function createTestEngine() {
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
          options: Object.keys(roles).map((role) => ({ value: role, label: role })),
        },
      },
    },
  );
  engine.registerApproverType(
    'supervisor',
    ({ level }, context) => {
      let current: string | undefined = context.requester.id;
      for (let i = 0; i < Number(level ?? 1) && current !== undefined; i++)
        current = supervisors[current];
      return current === undefined ? [] : [current];
    },
    {
      label: 'Manager',
      description: "The requester's manager",
      configSchema: { level: { type: 'number', label: 'Level', required: true } },
    },
  );
  engine.registerChain('supervisor', (userId) => supervisors[userId] ?? null, {
    label: 'Reporting',
  });
  return engine;
}

export const approverTypes: ApproverTypeInfo[] = createTestEngine().getApproverTypes();
export const chains: ChainInfo[] = createTestEngine().getChains();
