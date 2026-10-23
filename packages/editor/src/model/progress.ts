import type {
  ApprovalMode,
  AuditEntry,
  FlowDefinition,
  InstanceState,
  Step,
  StepGroupConfig,
} from '@paraf/core';

/** Where one node stands for an instance. */
export type NodeProgressStatus = 'done' | 'active' | 'rejected' | 'not-reached';

/** A level of an approval chain. */
export interface LevelProgress {
  level: number;
  userId: string | null;
  status: Step['status'];
}

/** Approvals so far in one group of the latest step. */
export interface GroupProgress {
  id: string;
  label: string;
  approved: number;
  required: number;
}

export interface NodeProgress {
  status: NodeProgressStatus;
  /** Users who approved the latest visit, with the time of the last decision. */
  approvedBy: string[];
  decidedAt: Date | null;
  levels: LevelProgress[];
  groups: GroupProgress[];
}

/** An instance's position in its flow, for the progress view. */
export interface FlowProgress {
  nodes: Record<string, NodeProgress>;
  /** IDs of edges (`source:handle`) the instance went along. */
  takenEdges: Set<string>;
  /** The step waiting for decisions, if any. */
  activeStep: Step | null;
}

function required(mode: ApprovalMode, group: StepGroupConfig, counted: number): number {
  if (mode === 'any') return 1;
  if (mode === 'all') return counted;
  return group.minimum ?? mode.minimum;
}

/** Entries since the last resubmission: the current round. */
function currentRound(history: readonly AuditEntry[]): readonly AuditEntry[] {
  const last = history.map((entry) => entry.action).lastIndexOf('resubmitted');
  return last === -1 ? history : history.slice(last + 1);
}

/** Computes node statuses and taken edges from the instance state and its audit trail. */
export function progressOf(
  flow: FlowDefinition,
  state: InstanceState,
  history: readonly AuditEntry[],
): FlowProgress {
  const { instance } = state;
  const nodes: Record<string, NodeProgress> = {};
  const takenEdges = new Set<string>();
  const empty = (): NodeProgress => ({
    status: 'not-reached',
    approvedBy: [],
    decidedAt: null,
    levels: [],
    groups: [],
  });
  for (const id of Object.keys(flow.nodes)) nodes[id] = empty();

  const steps = state.steps.filter((step) => step.round === instance.round);
  for (const id of Object.keys(flow.nodes)) {
    const visits = steps.filter((step) => step.nodeId === id);
    if (visits.length === 0) continue;
    const iteration = Math.max(...visits.map((step) => step.iteration));
    const latest = visits
      .filter((step) => step.iteration === iteration)
      .sort((a, b) => a.chainLevel - b.chainLevel);
    const last = latest[latest.length - 1] as Step;
    const progress = nodes[id] as NodeProgress;
    const slots = state.approvers.filter((slot) => latest.some((step) => step.id === slot.stepId));

    if (latest.some((step) => step.status === 'active' || step.status === 'returned')) {
      progress.status = 'active';
    } else if (last.status === 'rejected') {
      progress.status = 'rejected';
      takenEdges.add(`${id}:reject`);
    } else if (last.status === 'approved' || last.status === 'skipped') {
      progress.status = 'done';
      takenEdges.add(`${id}:next`);
    }
    const approved = slots.filter((slot) => slot.status === 'approved');
    progress.approvedBy = [...new Set(approved.map((slot) => slot.userId))];
    progress.decidedAt = approved.reduce<Date | null>(
      (latestAt, slot) =>
        slot.decidedAt && (!latestAt || slot.decidedAt > latestAt) ? slot.decidedAt : latestAt,
      null,
    );
    if (flow.nodes[id]?.type === 'approval-chain') {
      progress.levels = latest.map((step) => ({
        level: step.chainLevel,
        userId: step.config.chain?.userId ?? null,
        status: step.status,
      }));
    } else {
      progress.groups = last.config.groups
        .filter((group) => !group.override)
        .map((group) => {
          const counted = slots.filter(
            (slot) =>
              slot.stepId === last.id &&
              slot.groupId === group.id &&
              ['pending', 'approved', 'rejected'].includes(slot.status),
          );
          return {
            id: group.id,
            label: group.label ?? group.id,
            approved: counted.filter((slot) => slot.status === 'approved').length,
            required: required(group.mode, group, counted.length),
          };
        });
    }
  }

  for (const entry of currentRound(history)) {
    if (entry.nodeId === null || !(entry.nodeId in nodes)) continue;
    const progress = nodes[entry.nodeId] as NodeProgress;
    if (entry.action === 'condition_evaluated') {
      progress.status = 'done';
      const rule = entry.metadata?.matchedRule;
      takenEdges.add(`${entry.nodeId}:${typeof rule === 'number' ? `rule-${rule}` : 'else'}`);
    } else if (entry.action === 'completed') {
      progress.status = 'done';
    }
  }

  const activeStep = state.steps.find((step) => step.id === instance.currentStepId) ?? null;
  return { nodes, takenEdges, activeStep };
}
