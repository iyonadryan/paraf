import type { FlowDefinition } from '../../src';

/** The example from the specification: chain, condition, and parallel groups. */
export const purchaseRequestFlow = {
  id: 'purchase-request',
  version: 1,
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
  layout: { supervisor: { x: 100, y: 80 } },
} satisfies FlowDefinition;

/** The "quick look" example from the README: supervisor, then director. */
export const twoLevelFlow = {
  id: 'purchase-request',
  name: 'Purchase Request',
  start: 'supervisor',
  nodes: {
    supervisor: {
      type: 'approval',
      approvers: [{ type: 'supervisor', level: 1 }],
      mode: 'any',
      next: 'director',
      onReject: 'rejected',
    },
    director: {
      type: 'approval',
      approvers: [{ type: 'role', value: 'director' }],
      mode: 'all',
      next: 'approved',
      onReject: 'rejected',
    },
    approved: { type: 'end', result: 'approved' },
    rejected: { type: 'end', result: 'rejected' },
  },
} satisfies FlowDefinition;

/**
 * A director submitting their own request: after `excludeRequester` the director level is
 * empty and skipped.
 */
export const requesterAtTopFlow = {
  id: 'leave-request',
  name: 'Leave Request',
  start: 'director',
  nodes: {
    director: {
      type: 'approval',
      approvers: [{ type: 'role', value: 'director' }],
      mode: 'any',
      excludeRequester: true,
      onEmptyApprovers: 'skip',
      next: 'approved',
      onReject: 'rejected',
    },
    approved: { type: 'end', result: 'approved' },
    rejected: { type: 'end', result: 'rejected' },
  },
} satisfies FlowDefinition;

/** Exercises the remaining options: fixed users, fallbacks, every require form, rich conditions. */
export const kitchenSinkFlow = {
  id: 'capex_2026',
  version: 3,
  name: 'Capital Expenditure',
  start: 'route',
  resubmitPolicy: 'resume',
  nodes: {
    route: {
      type: 'condition',
      label: 'Route by department',
      rules: [
        {
          label: 'IT, large',
          when: {
            and: [
              { '==': [{ var: 'departmentId' }, 'IT'] },
              { '>=': [{ var: ['items.0.price', 0] }, 5000] },
            ],
          },
          next: 'committee',
        },
        {
          when: {
            or: [
              { in: [{ var: 'category' }, ['hardware', 'software']] },
              { not: { '<': [{ var: 'amount' }, 100] } },
              { '!=': [{ var: 'urgent' }, true] },
              { '<=': [{ var: 'amount' }, 1] },
            ],
          },
          next: 'pic',
        },
      ],
      else: 'committee',
    },
    pic: {
      type: 'approval-chain',
      chain: 'supervisor',
      from: { field: 'pic_user_id' },
      maxLevels: 1,
      excludeRequester: true,
      onEmptyApprovers: 'fallback',
      fallbackApprovers: [{ type: 'user', value: 'u-admin' }],
      timeout: { after: 'PT12H', action: 'escalate', to: [{ type: 'field', value: 'backup_id' }] },
      next: 'committee',
      onReject: 'rejected',
    },
    committee: {
      type: 'approval',
      approvers: [
        { type: 'user', value: ['u1', 'u2', 'u3'] },
        { type: 'user', value: 'u4' },
        { type: 'supervisor', level: 2 },
      ],
      mode: { minimum: 3 },
      rejectPolicy: { minimum: 2 },
      onEmptyApprovers: 'error',
      onInsufficientApprovers: 'fallback',
      fallbackApprovers: [{ type: 'role', value: 'committee-reserve' }],
      next: 'boards',
      onReject: 'rejected',
    },
    boards: {
      type: 'approval',
      groups: [
        { id: 'a', approvers: [{ type: 'role', value: 'board-a' }], mode: 'all' },
        { id: 'b', approvers: [{ type: 'role', value: 'board-b' }], mode: 'any' },
        {
          id: 'c',
          approvers: [{ type: 'role', value: 'board-c' }],
          mode: { minimum: 2 },
          rejectPolicy: 'any',
          excludeRequester: true,
          onEmptyApprovers: 'skip',
        },
      ],
      require: { minimum: 2 },
      countAcrossGroups: false,
      next: 'anyBoard',
      onReject: 'rejected',
    },
    anyBoard: {
      type: 'approval',
      groups: [
        { id: 'x', approvers: [{ type: 'role', value: 'x' }], mode: 'any' },
        { id: 'y', approvers: [{ type: 'role', value: 'y' }], mode: 'any' },
      ],
      require: 'any',
      next: 'approved',
      onReject: 'rejected',
    },
    approved: { type: 'end', label: 'Done', result: 'approved' },
    rejected: { type: 'end', result: 'rejected' },
  },
  layout: { route: { x: 0, y: 0 }, pic: { x: -120.5, y: 200 } },
} satisfies FlowDefinition;

export const validFlows: Record<string, FlowDefinition> = {
  purchaseRequestFlow,
  twoLevelFlow,
  requesterAtTopFlow,
  kitchenSinkFlow,
};

/** Registries that make every valid fixture pass the registration checks. */
export const registries = {
  approverTypes: ['role', 'supervisor'],
  chains: ['supervisor'],
};
