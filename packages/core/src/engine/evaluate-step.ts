import type { ApproverSlot, GroupStatus, Step, StepGroupConfig } from '../types/instance';

/** Slots that take part in a group's decision. */
export function countedSlots(slots: readonly ApproverSlot[], groupId: string): ApproverSlot[] {
  return slots.filter(
    (slot) =>
      slot.groupId === groupId &&
      (slot.status === 'pending' || slot.status === 'approved' || slot.status === 'rejected'),
  );
}

/** Approvals a group needs, given its counted slots. */
export function requiredApprovals(group: StepGroupConfig, counted: number): number {
  if (group.mode === 'any') return 1;
  if (group.mode === 'all') return counted;
  return group.minimum ?? group.mode.minimum;
}

/**
 * Decides a pending group from its slots:
 * - approved once approvals reach the requirement;
 * - rejected when the reject policy triggers, or when approval can no longer be reached
 *   (so a group never waits forever).
 */
export function decideGroup(group: StepGroupConfig, slots: readonly ApproverSlot[]): GroupStatus {
  const counted = countedSlots(slots, group.id);
  const approvals = counted.filter((slot) => slot.status === 'approved').length;
  const rejections = counted.filter((slot) => slot.status === 'rejected').length;
  const pending = counted.filter((slot) => slot.status === 'pending').length;
  const required = requiredApprovals(group, counted.length);

  if (approvals >= required) return 'approved';
  const policy = group.rejectPolicy;
  const policyTriggered =
    policy === 'any'
      ? rejections >= 1
      : policy === 'impossible'
        ? false
        : rejections >= policy.minimum;
  if (policyTriggered || approvals + pending < required) return 'rejected';
  return 'pending';
}

/** Groups the node's `require` needs, out of `count` regular groups. */
export function requiredGroups(step: Step, count: number): number {
  const { require } = step.config;
  if (require === 'all') return count;
  if (require === 'any') return 1;
  return require.minimum;
}

/**
 * Re-evaluates every pending group of the step (updating `config.groups[].status`) and returns
 * the step outcome, or `null` while it is still undecided. Skipped groups count as satisfied.
 * A decided escalation (override) group decides the step on its own.
 */
export function evaluateStep(
  step: Step,
  slots: readonly ApproverSlot[],
): 'approved' | 'rejected' | null {
  for (const group of step.config.groups) {
    if (group.status === 'pending') group.status = decideGroup(group, slots);
  }
  const override = step.config.groups.find((group) => group.override && group.status !== 'pending');
  if (override) return override.status === 'approved' ? 'approved' : 'rejected';

  const regular = step.config.groups.filter((group) => !group.override);
  const statuses = regular.map((group) => group.status);
  const satisfied = statuses.filter((status) => status === 'approved' || status === 'skipped');
  const undecided = statuses.filter((status) => status === 'pending');
  const required = requiredGroups(step, regular.length);

  if (satisfied.length >= required) return 'approved';
  if (satisfied.length + undecided.length < required) return 'rejected';
  return null;
}
