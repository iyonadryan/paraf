import type { ApproverEntry, FlowDefinition, FlowNode } from '@paraf/core';
import { setPositions } from './edit';
import { autoLayout } from './layout';

/** Starting points offered on an empty canvas. */
export type TemplateId = 'single' | 'multi' | 'amount';

const ENDS: Record<string, FlowNode> = {
  approved: { type: 'end', label: 'Approved', result: 'approved' },
  rejected: { type: 'end', label: 'Rejected', result: 'rejected' },
};

function approval(label: string, approver: ApproverEntry, next: string): FlowNode {
  return {
    type: 'approval',
    label,
    approvers: [approver],
    mode: 'any',
    next,
    onReject: 'rejected',
  };
}

/**
 * Replaces the flow's nodes with a template, keeping its id and name. Approvers use the given
 * approver type with no configuration yet, so the new nodes show what is left to fill in.
 */
export function applyTemplate(
  flow: FlowDefinition,
  template: TemplateId,
  approverType: string,
): FlowDefinition {
  const approver: ApproverEntry = { type: approverType };
  const base: FlowDefinition = { id: flow.id, name: flow.name, start: '', nodes: {} };
  let next: FlowDefinition;
  if (template === 'single') {
    next = {
      ...base,
      start: 'approval',
      nodes: { approval: approval('Approval', approver, 'approved'), ...ENDS },
    };
  } else if (template === 'multi') {
    next = {
      ...base,
      start: 'level_1',
      nodes: {
        level_1: approval('Level 1', approver, 'level_2'),
        level_2: approval('Level 2', approver, 'approved'),
        ...ENDS,
      },
    };
  } else {
    next = {
      ...base,
      start: 'check_amount',
      variables: [{ key: 'amount', label: 'Amount', type: 'number', required: true }],
      nodes: {
        check_amount: {
          type: 'condition',
          label: 'Check amount',
          rules: [{ when: { '>': [{ var: 'amount' }, 10_000_000] }, next: 'high_amount' }],
          else: 'standard',
        },
        high_amount: approval('High amount', approver, 'approved'),
        standard: approval('Standard', approver, 'approved'),
        ...ENDS,
      },
    };
  }
  return setPositions(next, autoLayout(next));
}
