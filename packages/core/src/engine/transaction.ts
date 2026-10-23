import { evaluateCondition, isTruthy, readPath } from '../condition/evaluate';
import { addDuration, parseDuration } from '../duration';
import type { OperatorFunction } from '../condition/evaluate';
import {
  ChainCycleError,
  DelegationError,
  DocumentValidationError,
  EmptyApproversError,
  InsufficientApproversError,
  InvalidArgumentError,
  InvalidStateError,
  NotAuthorizedError,
  ParafError,
  UnknownApproverTypeError,
  UnknownChainError,
} from '../errors';
import type { ActionErrorContext, StepEntryErrorContext } from '../errors';
import type {
  ApprovalChainNode,
  ApprovalNode,
  ApproverEntry,
  ApproverGroupRules,
  DuplicateApproverPolicy,
  FlowDefinition,
  FlowNode,
  ResubmitPolicy,
} from '../types/flow';
import type {
  ApproverSlot,
  AuditAction,
  AuditEntry,
  InstanceState,
  Step,
  StepChainConfig,
  StepConfig,
  StepGroupConfig,
  StepStatus,
} from '../types/instance';
import type { JsonObject } from '../types/json';
import type { IdGenerator } from '../uuid';
import { validateDocument } from '../document';
import { clone } from '../utils/clone';
import { countedSlots, evaluateStep, requiredApprovals } from './evaluate-step';
import type {
  ApproverChange,
  ParafEventName,
  ParafEvents,
  QueuedEvent,
  RequiredApprovers,
} from './events';
import type { ApproverTypeRegistry, ChainRegistry, ResolverContext } from './registry';

/** Engine parts a transaction needs. */
export interface TransactionServices {
  approverTypes: ApproverTypeRegistry;
  chains: ChainRegistry;
  operators: ReadonlyMap<string, OperatorFunction>;
  generateId: IdGenerator;
  isAdmin: (userId: string, state: InstanceState) => Promise<boolean>;
}

/** A group of an approval node with its rules (the short form becomes group `"default"`). */
interface GroupDefinition extends ApproverGroupRules {
  id: string;
  label?: string;
}

/** Outcome of resolving one group's approvers and applying its policies. */
interface GroupResolution {
  users: Map<string, ApproverEntry | null>;
  status: 'pending' | 'skipped';
  /** Effective minimum when capped. */
  minimum?: number;
  notes: JsonObject;
}

/** The user found for one chain level. */
interface ChainLevel {
  userId: string;
  stopper: boolean;
}

/** Why an approval chain ended; recorded in the `chain_completed` audit entry. */
type ChainEnd = 'until' | 'top' | 'max_levels' | 'fallback';

/** Approval and approval-chain nodes: the nodes that create steps. */
type StepNode = ApprovalNode | ApprovalChainNode;

const SINGLE_GROUP_ID = 'default';

/** Group added by a timeout escalation. Not a valid slug, so it never clashes with flow groups. */
export const ESCALATION_GROUP_ID = '$escalation';

function groupsOf(node: ApprovalNode): GroupDefinition[] {
  if (node.groups) return node.groups;
  return [
    {
      id: SINGLE_GROUP_ID,
      approvers: node.approvers,
      mode: node.mode,
      rejectPolicy: node.rejectPolicy,
      excludeRequester: node.excludeRequester,
      onEmptyApprovers: node.onEmptyApprovers,
      onInsufficientApprovers: node.onInsufficientApprovers,
      fallbackApprovers: node.fallbackApprovers,
    },
  ];
}

/** The single group of a chain step: one approver per level, or the fallback approvers. */
function chainGroup(node: ApprovalChainNode): GroupDefinition {
  return {
    id: SINGLE_GROUP_ID,
    approvers: node.fallbackApprovers ?? [],
    mode: 'any',
    excludeRequester: node.excludeRequester,
  };
}

function defaultRejectPolicy(group: GroupDefinition): StepGroupConfig['rejectPolicy'] {
  if (group.rejectPolicy !== undefined) return group.rejectPolicy;
  return typeof group.mode === 'object' ? 'impossible' : 'any';
}

/**
 * One attempt at an action: works on a private copy of the instance state, collects audit
 * entries and events, and leaves persisting to the engine.
 */
export class Transaction {
  readonly audit: AuditEntry[] = [];
  private readonly queued: (() => QueuedEvent)[] = [];

  constructor(
    readonly state: InstanceState,
    readonly flow: FlowDefinition,
    readonly now: Date,
    private readonly services: TransactionServices,
    readonly context: ActionErrorContext,
  ) {}

  get instance() {
    return this.state.instance;
  }

  /** Events with payloads taken from the final state, safe to hand to listeners. */
  events(): QueuedEvent[] {
    return this.queued.map((build) => build());
  }

  // ---------------------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------------------

  /** Records the start of the instance and runs the flow from its start node. */
  async start(): Promise<void> {
    this.record('started', { actorId: this.instance.requesterId });
    this.emit('instance.created', () => ({ instance: clone(this.instance) }));
    await this.enterNode(this.flow.start);
  }

  /** Approves or rejects on behalf of a pending approver of the active step. */
  async decide(
    userId: string,
    decision: 'approved' | 'rejected',
    comment: string | null,
  ): Promise<void> {
    const step = this.requireActiveStep();
    const slots = this.pendingSlots(step, userId);
    if (slots.length === 0) {
      throw new NotAuthorizedError('User is not a pending approver of the active step', {
        ...this.context,
        nodeId: step.nodeId,
      });
    }
    for (const slot of slots) {
      slot.status = decision;
      slot.decidedAt = this.now;
      slot.comment = comment;
    }
    this.markInProgress();
    this.record(decision, {
      step,
      actorId: userId,
      comment,
      metadata: { groupIds: slots.map((slot) => slot.groupId) },
    });
    await this.settle(step);
  }

  /** Moves a pending approver's vote to another user in every group of the active step. */
  async delegate(fromUserId: string, toUserId: string, reason: string | null): Promise<void> {
    const step = this.requireActiveStep();
    const context = { ...this.context, nodeId: step.nodeId };
    if (toUserId === '' || toUserId === fromUserId) {
      throw new DelegationError('A vote must be delegated to another user', context);
    }
    const slots = this.pendingSlots(step, fromUserId);
    if (slots.length === 0) {
      throw new NotAuthorizedError('User is not a pending approver of the active step', context);
    }

    const added: RequiredApprovers[] = [];
    for (const slot of slots) {
      const group = this.groupConfig(step, slot.groupId);
      if (group.excludeRequester && toUserId === this.instance.requesterId) {
        throw new DelegationError('The requester cannot approve in this group', {
          ...context,
          groupId: group.id,
        });
      }
      slot.status = 'delegated';
      const existing = this.slotsOf(step).find(
        (other) => other.groupId === slot.groupId && other.userId === toUserId,
      );
      if (existing && existing.status !== 'delegated') continue;
      if (existing) {
        existing.status = 'pending';
        existing.delegatedFrom = fromUserId;
      } else {
        this.state.approvers.push(
          this.newSlot(step, slot.groupId, toUserId, slot.source, fromUserId),
        );
      }
      added.push(this.requiredFor(group, [toUserId]));
    }

    for (const group of step.config.groups) {
      if (group.status !== 'pending') continue;
      const counted = countedSlots(this.slotsOf(step), group.id);
      const reachable = counted.filter((slot) => slot.status !== 'rejected').length;
      if (reachable < requiredApprovals(group, counted.length)) {
        throw new DelegationError(
          `Delegation would leave fewer approvers than the group's minimum`,
          { ...context, groupId: group.id },
        );
      }
    }

    this.markInProgress();
    this.record('delegated', {
      step,
      actorId: fromUserId,
      comment: reason,
      metadata: { to: toUserId, groupIds: slots.map((slot) => slot.groupId) },
    });
    if (added.length > 0) this.emitApprovalRequired(step, 'delegated', added);
    await this.settle(step);
  }

  /** Sends the active step back to the requester, or to a node visited earlier this round. */
  async returnForRevision(
    userId: string,
    comment: string,
    options: { toNodeId?: string; resubmitPolicy?: ResubmitPolicy },
  ): Promise<void> {
    const step = this.requireActiveStep();
    const isApprover = this.pendingSlots(step, userId).length > 0;
    if (!isApprover && !(await this.services.isAdmin(userId, this.state))) {
      throw new NotAuthorizedError('Only a pending approver or an admin can return the instance', {
        ...this.context,
        nodeId: step.nodeId,
      });
    }

    const { toNodeId } = options;
    if (toNodeId !== undefined) {
      const visited = this.state.steps.some(
        (other) => other.nodeId === toNodeId && other.round === this.instance.round,
      );
      if (!visited) {
        throw new InvalidArgumentError(
          `Node "${toNodeId}" has not been visited in the current round`,
          { ...this.context, nodeId: toNodeId },
        );
      }
    }

    const resubmitPolicy = options.resubmitPolicy ?? this.flow.resubmitPolicy ?? 'restart';
    if (toNodeId === undefined) step.config.resubmitPolicy = resubmitPolicy;
    this.completeStep(step, 'returned');
    this.record('returned', {
      step,
      actorId: userId,
      comment,
      metadata: {
        toNodeId: toNodeId ?? null,
        ...(toNodeId === undefined ? { resubmitPolicy } : {}),
      },
    });
    this.emit('instance.returned', () => ({
      instance: clone(this.instance),
      step: clone(step),
      toNodeId: toNodeId ?? null,
    }));

    if (toNodeId === undefined) {
      this.instance.status = 'returned';
      return;
    }
    this.markInProgress();
    await this.enterNode(toNodeId);
  }

  /** Continues a returned instance in a new round. */
  async resubmit(userId: string, document: JsonObject | undefined): Promise<void> {
    if (userId !== this.instance.requesterId) {
      throw new NotAuthorizedError('Only the requester can resubmit', this.context);
    }
    if (this.instance.status !== 'returned') {
      throw new InvalidStateError(
        `Only a returned instance can be resubmitted; status is "${this.instance.status}"`,
        this.context,
      );
    }
    const returned = [...this.state.steps].reverse().find((step) => step.status === 'returned');
    if (!returned) {
      throw new InvalidStateError('No returned step to resume from', this.context);
    }
    const policy = returned.config.resubmitPolicy ?? 'restart';

    this.instance.round += 1;
    this.instance.status = 'pending';
    if (document !== undefined) {
      const problems = validateDocument(document, this.flow.variables);
      if (problems.length > 0) throw new DocumentValidationError(problems, this.context);
      this.instance.document = clone(document);
    }
    this.record('resubmitted', {
      actorId: userId,
      metadata: { round: this.instance.round, resubmitPolicy: policy },
    });
    await this.enterNode(policy === 'restart' ? this.flow.start : returned.nodeId);
  }

  /** Cancels a running instance. */
  async cancel(userId: string, reason: string | null): Promise<void> {
    if (
      userId !== this.instance.requesterId &&
      !(await this.services.isAdmin(userId, this.state))
    ) {
      throw new NotAuthorizedError('Only the requester or an admin can cancel', this.context);
    }
    this.requireRunning();
    const step = this.activeStep();
    if (step) this.completeStep(step, 'cancelled');
    this.instance.status = 'cancelled';
    this.instance.completedAt = this.now;
    this.record('cancelled', { step, actorId: userId, comment: reason });
    this.emit('instance.completed', () => ({ instance: clone(this.instance) }));
  }

  /** Resolves the active step's approvers again, keeping decisions already made. */
  async reresolve(actorId: string): Promise<void> {
    if (!(await this.services.isAdmin(actorId, this.state))) {
      throw new NotAuthorizedError('Only an admin can re-resolve approvers', this.context);
    }
    const step = this.requireActiveStep();
    const node = this.stepNode(step.nodeId);
    if (node.type === 'approval-chain' && step.config.chain) {
      await this.reresolveChainLevel(node, step, step.config.chain, actorId);
      return;
    }

    const added: ApproverChange[] = [];
    const removed: ApproverChange[] = [];
    const taken = new Set<string>();
    const definitions = node.type === 'approval' ? groupsOf(node) : [chainGroup(node)];
    for (const definition of definitions) {
      const group = this.groupConfig(step, definition.id);
      const groupSlots = () => this.slotsOf(step).filter((slot) => slot.groupId === group.id);
      if (group.status !== 'pending') {
        for (const slot of groupSlots()) taken.add(slot.userId);
        continue;
      }

      const candidates = await this.resolveCandidates(
        step,
        definition,
        taken,
        step.config.countAcrossGroups,
      );
      // Decisions and delegations already made stay; other pending approvers are replaced.
      const kept = groupSlots().filter(
        (slot) =>
          slot.status !== 'pending' || slot.delegatedFrom !== null || candidates.has(slot.userId),
      );
      const keptUsers = new Set(kept.map((slot) => slot.userId));
      const votingUsers = new Set(
        kept.filter((slot) => slot.status !== 'delegated').map((slot) => slot.userId),
      );
      // Users who delegated their vote do not get it back.
      for (const userId of keptUsers) {
        if (!votingUsers.has(userId)) candidates.delete(userId);
      }
      const resolution = await this.applyPolicies(step, definition, candidates, votingUsers);

      for (const slot of groupSlots()) {
        if (!kept.includes(slot)) {
          this.removeSlot(slot);
          removed.push({ groupId: group.id, userId: slot.userId });
        }
      }
      for (const [userId, source] of resolution.users) {
        if (!keptUsers.has(userId)) {
          this.state.approvers.push(this.newSlot(step, group.id, userId, source, null));
          added.push({ groupId: group.id, userId });
        }
      }
      group.status = resolution.status;
      if (resolution.minimum !== undefined) group.minimum = resolution.minimum;
      for (const slot of groupSlots()) taken.add(slot.userId);
    }

    this.recordReresolved(step, actorId, added, removed);
    await this.settle(step);
  }

  /**
   * Escalates the active step if it is due at `now`: the node's `timeout.to` approvers join as
   * an override group (one decision of theirs decides the step) and the deadline is cleared, so
   * a step escalates once. Returns `false` when there is nothing to do (e.g. the step changed
   * since it was found).
   */
  async escalate(now: Date): Promise<boolean> {
    const step = this.activeStep();
    if (!step || step.dueAt === null || step.dueAt > now) return false;
    const dueAt = step.dueAt;
    step.dueAt = null;

    const timeout = this.stepNode(step.nodeId).timeout;
    const excludeRequester = step.config.groups.some((group) => group.excludeRequester);
    const users = await this.resolveEntries(
      step.nodeId,
      ESCALATION_GROUP_ID,
      excludeRequester,
      timeout?.to ?? [],
      new Set(),
      false,
    );
    const group: StepGroupConfig = {
      id: ESCALATION_GROUP_ID,
      mode: 'any',
      rejectPolicy: 'any',
      excludeRequester,
      status: 'pending',
      override: true,
    };
    if (users.size > 0) {
      step.config.groups.push(group);
      for (const [userId, source] of users) {
        this.state.approvers.push(this.newSlot(step, group.id, userId, source, null));
      }
    }

    const approvers = [...users.keys()];
    this.record('escalated', {
      step,
      metadata: { approvers, dueAt: dueAt.toISOString() },
    });
    this.emit('timeout.escalated', () => ({
      instance: clone(this.instance),
      step: clone(step),
      approvers,
    }));
    if (users.size > 0) {
      this.emitApprovalRequired(step, 'escalated', [this.requiredFor(group, approvers)]);
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------
  // Flow traversal
  // ---------------------------------------------------------------------------------------

  private async enterNode(nodeId: string): Promise<void> {
    const node: FlowNode | undefined = this.flow.nodes[nodeId];
    if (!node) {
      throw new ParafError('UNKNOWN_NODE', `Flow "${this.flow.id}" has no node "${nodeId}".`);
    }
    switch (node.type) {
      case 'end':
        this.instance.status = node.result;
        this.instance.currentStepId = null;
        this.instance.completedAt = this.now;
        this.record('completed', { nodeId, metadata: { result: node.result } });
        this.emit('instance.completed', () => ({ instance: clone(this.instance) }));
        return;
      case 'condition': {
        const index = node.rules.findIndex((rule) =>
          isTruthy(evaluateCondition(rule.when, this.instance.document, this.services.operators)),
        );
        const rule = node.rules[index];
        const next = rule === undefined ? node.else : rule.next;
        this.record('condition_evaluated', {
          nodeId,
          metadata: { matchedRule: rule === undefined ? null : index, next },
        });
        await this.enterNode(next);
        return;
      }
      case 'approval':
        await this.enterApproval(nodeId, node);
        return;
      default:
        await this.enterChain(nodeId, node);
    }
  }

  private async enterApproval(nodeId: string, node: ApprovalNode): Promise<void> {
    const iteration = this.nextIteration(nodeId);
    const step = this.newStep(nodeId, iteration, 0, {
      require: node.require ?? 'all',
      countAcrossGroups: node.countAcrossGroups ?? true,
      groups: [],
    });
    this.instance.currentStepId = step.id;

    const taken = new Set<string>();
    const summary: JsonObject[] = [];
    for (const definition of groupsOf(node)) {
      const candidates = await this.resolveCandidates(
        step,
        definition,
        taken,
        step.config.countAcrossGroups,
      );
      const resolution = await this.applyPolicies(step, definition, candidates, new Set());
      const group: StepGroupConfig = {
        id: definition.id,
        ...(definition.label === undefined ? {} : { label: definition.label }),
        mode: definition.mode,
        ...(resolution.minimum === undefined ? {} : { minimum: resolution.minimum }),
        rejectPolicy: defaultRejectPolicy(definition),
        excludeRequester: definition.excludeRequester ?? false,
        status: resolution.status,
      };
      step.config.groups.push(group);
      for (const [userId, source] of resolution.users) {
        this.state.approvers.push(this.newSlot(step, group.id, userId, source, null));
        taken.add(userId);
      }
      summary.push({
        groupId: group.id,
        approvers: [...resolution.users.keys()],
        ...resolution.notes,
      });
    }

    await this.openStep(step, node.duplicateApprover, { iteration, groups: summary });
  }

  /** Records a freshly built step, applies duplicate-approver handling, and settles it. */
  private async openStep(
    step: Step,
    duplicateApprover: DuplicateApproverPolicy | undefined,
    metadata: JsonObject,
  ): Promise<void> {
    this.record('step_entered', { step, metadata });
    for (const group of step.config.groups) {
      if (group.status === 'skipped') {
        this.record('skipped', { step, metadata: { groupId: group.id, reason: 'no_approvers' } });
      }
    }
    this.emit('step.entered', () => ({ instance: clone(this.instance), step: clone(step) }));
    if (duplicateApprover === 'auto-approve') this.autoApprove(step);

    await this.settle(step);
    if (step.status === 'active') {
      const groups = step.config.groups
        .filter((group) => group.status === 'pending')
        .map((group) =>
          this.requiredFor(
            group,
            this.slotsOf(step)
              .filter((slot) => slot.groupId === group.id && slot.status === 'pending')
              .map((slot) => slot.userId),
          ),
        );
      this.emitApprovalRequired(step, 'entered', groups);
    }
  }

  /** Re-evaluates a step and moves on when it is decided. */
  private async settle(step: Step): Promise<void> {
    const outcome = evaluateStep(step, this.slotsOf(step));
    for (const group of step.config.groups) {
      if (group.status === 'pending') continue;
      for (const slot of this.slotsOf(step)) {
        if (slot.groupId === group.id && slot.status === 'pending') slot.status = 'skipped';
      }
    }
    if (outcome === null) return;

    const allSkipped = step.config.groups.every((group) => group.status === 'skipped');
    this.completeStep(step, outcome === 'approved' && allSkipped ? 'skipped' : outcome);
    if (allSkipped) this.record('skipped', { step, metadata: { reason: 'no_approvers' } });
    const node = this.stepNode(step.nodeId);
    if (outcome === 'rejected') {
      await this.enterNode(node.onReject);
    } else if (node.type === 'approval-chain') {
      await this.continueChain(node, step);
    } else {
      await this.enterNode(node.next);
    }
  }

  private completeStep(step: Step, status: StepStatus): void {
    step.status = status;
    step.completedAt = this.now;
    for (const slot of this.slotsOf(step)) {
      if (slot.status === 'pending') slot.status = 'skipped';
    }
    this.instance.currentStepId = null;
    this.emit('step.completed', () => ({ instance: clone(this.instance), step: clone(step) }));
  }

  // ---------------------------------------------------------------------------------------
  // Approval chains
  // ---------------------------------------------------------------------------------------

  private async enterChain(nodeId: string, node: ApprovalChainNode): Promise<void> {
    const iteration = this.nextIteration(nodeId);
    const origin = this.chainOrigin(node);
    if (origin === null) {
      await this.enterEmptyChain(nodeId, node, iteration);
      return;
    }
    await this.walkChain(nodeId, node, iteration, 1, origin);
  }

  /** The user the chain starts from: the requester, or a user ID read from the document. */
  private chainOrigin(node: ApprovalChainNode): string | null {
    if (node.from === undefined || node.from === 'requester') return this.instance.requesterId;
    const value = readPath(this.instance.document, node.from.field);
    return typeof value === 'string' && value !== '' ? value : null;
  }

  /** Resolves level `level` from `fromUserId` and opens its step, or ends the chain. */
  private async walkChain(
    nodeId: string,
    node: ApprovalChainNode,
    iteration: number,
    level: number,
    fromUserId: string,
  ): Promise<void> {
    if (level > node.maxLevels) {
      await this.finishChain(nodeId, node, 'max_levels', level - 1);
      return;
    }
    const found = await this.resolveChainLevel(nodeId, node, iteration, level, fromUserId);
    if (found === null) {
      if (level === 1) await this.enterEmptyChain(nodeId, node, iteration);
      else await this.finishChain(nodeId, node, 'top', level - 1);
      return;
    }
    if (found.stopper && !(node.includeStopper ?? true)) {
      await this.finishChain(nodeId, node, 'until', level - 1);
      return;
    }

    const chain: StepChainConfig = { fromUserId, userId: found.userId, stopper: found.stopper };
    const step = this.newStep(nodeId, iteration, level, this.chainStepConfig(node, chain));
    if (node.excludeRequester && found.userId === this.instance.requesterId) {
      // The requester's own level: recorded as skipped, the chain continues above them.
      step.status = 'skipped';
      step.completedAt = this.now;
      step.dueAt = null;
      this.groupConfig(step, SINGLE_GROUP_ID).status = 'skipped';
      this.record('skipped', {
        step,
        metadata: { level, userId: found.userId, reason: 'requester' },
      });
      await this.continueChain(node, step);
      return;
    }

    this.instance.currentStepId = step.id;
    this.state.approvers.push(
      this.newSlot(step, SINGLE_GROUP_ID, found.userId, this.chainSource(node, level), null),
    );
    await this.openStep(step, node.duplicateApprover, {
      iteration,
      level,
      groups: [{ groupId: SINGLE_GROUP_ID, approvers: [found.userId] }],
    });
  }

  /** After a level is approved or skipped: end at the stopper, or walk one level up. */
  private async continueChain(node: ApprovalChainNode, step: Step): Promise<void> {
    const chain = step.config.chain;
    if (!chain) {
      await this.finishChain(step.nodeId, node, 'fallback', step.chainLevel);
    } else if (chain.stopper) {
      await this.finishChain(step.nodeId, node, 'until', step.chainLevel);
    } else {
      await this.walkChain(step.nodeId, node, step.iteration, step.chainLevel + 1, chain.userId);
    }
  }

  private async finishChain(
    nodeId: string,
    node: ApprovalChainNode,
    reason: ChainEnd,
    levels: number,
  ): Promise<void> {
    this.record('chain_completed', { nodeId, metadata: { reason, levels } });
    await this.enterNode(node.next);
  }

  /** No first level (no origin or no one above it): apply `onEmptyApprovers`. */
  private async enterEmptyChain(
    nodeId: string,
    node: ApprovalChainNode,
    iteration: number,
  ): Promise<void> {
    const policy = node.onEmptyApprovers ?? 'error';
    if (policy === 'skip') {
      this.record('skipped', { nodeId, metadata: { reason: 'empty_chain' } });
      await this.enterNode(node.next);
      return;
    }
    const context = this.stepEntryContext(nodeId, SINGLE_GROUP_ID);
    if (policy === 'error') throw new EmptyApproversError(context);

    const group = chainGroup(node);
    const users = await this.resolveEntries(
      nodeId,
      group.id,
      group.excludeRequester ?? false,
      group.approvers,
      new Set(),
      false,
    );
    if (users.size === 0) throw new EmptyApproversError(context);
    const step = this.newStep(nodeId, iteration, 1, this.chainStepConfig(node, undefined));
    this.instance.currentStepId = step.id;
    for (const [userId, source] of users) {
      this.state.approvers.push(this.newSlot(step, SINGLE_GROUP_ID, userId, source, null));
    }
    await this.openStep(step, node.duplicateApprover, {
      iteration,
      level: 1,
      groups: [{ groupId: SINGLE_GROUP_ID, approvers: [...users.keys()], fallback: 'empty' }],
    });
  }

  /**
   * Asks the chain for the user above `fromUserId`. Returns `null` at the top of the chain and
   * throws `ChainCycleError` when the chain returns a user it already passed.
   */
  private async resolveChainLevel(
    nodeId: string,
    node: ApprovalChainNode,
    iteration: number,
    level: number,
    fromUserId: string,
  ): Promise<ChainLevel | null> {
    const context = this.stepEntryContext(nodeId, SINGLE_GROUP_ID);
    const resolver = this.services.chains.get(node.chain);
    if (!resolver) throw new UnknownChainError(node.chain, context);

    const userId = await resolver(fromUserId, { ...this.instanceContext(nodeId), level });
    if (typeof userId !== 'string' || userId === '') return null;

    const path = this.chainPath(nodeId, iteration, level, fromUserId);
    if (path.includes(userId)) throw new ChainCycleError([...path, userId], context);

    const until = node.until;
    const stopper =
      until !== undefined &&
      (await this.resolveEntries(nodeId, SINGLE_GROUP_ID, false, [until], new Set(), false)).has(
        userId,
      );
    return { userId, stopper };
  }

  /** Users the chain passed before `level`, starting with its origin. */
  private chainPath(
    nodeId: string,
    iteration: number,
    level: number,
    fromUserId: string,
  ): string[] {
    const earlier: StepChainConfig[] = [];
    for (const step of this.state.steps) {
      const chain = step.config.chain;
      if (
        chain &&
        step.nodeId === nodeId &&
        step.iteration === iteration &&
        step.chainLevel < level
      ) {
        earlier.push(chain);
      }
    }
    const [first] = earlier;
    return first === undefined
      ? [fromUserId]
      : [first.fromUserId, ...earlier.map((chain) => chain.userId)];
  }

  /** Recomputes the user of the active chain level, e.g. after the org chart changed. */
  private async reresolveChainLevel(
    node: ApprovalChainNode,
    step: Step,
    chain: StepChainConfig,
    actorId: string,
  ): Promise<void> {
    const found = await this.resolveChainLevel(
      step.nodeId,
      node,
      step.iteration,
      step.chainLevel,
      chain.fromUserId,
    );
    const ends: ChainEnd | null =
      found === null ? 'top' : found.stopper && !(node.includeStopper ?? true) ? 'until' : null;
    const excluded =
      found !== null &&
      node.excludeRequester === true &&
      found.userId === this.instance.requesterId;
    const userId = found !== null && ends === null && !excluded ? found.userId : null;
    if (found !== null) {
      chain.userId = found.userId;
      chain.stopper = found.stopper;
    }

    const added: ApproverChange[] = [];
    const removed: ApproverChange[] = [];
    const slots = this.slotsOf(step);
    for (const slot of slots) {
      if (slot.status === 'pending' && slot.delegatedFrom === null && slot.userId !== userId) {
        this.removeSlot(slot);
        removed.push({ groupId: slot.groupId, userId: slot.userId });
      }
    }
    if (userId !== null && !slots.some((slot) => slot.userId === userId)) {
      this.state.approvers.push(
        this.newSlot(step, SINGLE_GROUP_ID, userId, this.chainSource(node, step.chainLevel), null),
      );
      added.push({ groupId: SINGLE_GROUP_ID, userId });
    }
    this.recordReresolved(step, actorId, added, removed);

    if (countedSlots(this.slotsOf(step), SINGLE_GROUP_ID).length > 0) {
      await this.settle(step);
      return;
    }
    // Nobody is left to approve this level.
    this.groupConfig(step, SINGLE_GROUP_ID).status = 'skipped';
    this.completeStep(step, 'skipped');
    this.record('skipped', {
      step,
      metadata: { level: step.chainLevel, reason: ends ?? 'requester' },
    });
    if (ends === null) await this.continueChain(node, step);
    else await this.finishChain(step.nodeId, node, ends, step.chainLevel - 1);
  }

  private chainStepConfig(node: ApprovalChainNode, chain: StepChainConfig | undefined): StepConfig {
    return {
      require: 'all',
      countAcrossGroups: true,
      groups: [
        {
          id: SINGLE_GROUP_ID,
          mode: 'any',
          rejectPolicy: 'any',
          excludeRequester: node.excludeRequester ?? false,
          status: 'pending',
        },
      ],
      ...(chain === undefined ? {} : { chain }),
    };
  }

  private chainSource(node: ApprovalChainNode, level: number): ApproverEntry {
    return { type: 'chain', chain: node.chain, level };
  }

  // ---------------------------------------------------------------------------------------
  // Duplicate approvers
  // ---------------------------------------------------------------------------------------

  /**
   * Approves the slots of users who already approved another node in this round (not a
   * returned step, and not an earlier visit of the same node). Runs on a freshly opened step,
   * whose slots are all pending.
   */
  private autoApprove(step: Step): void {
    const byUser = new Map<string, { groupIds: string[]; fromStepId: string }>();
    for (const slot of this.slotsOf(step)) {
      const earlier = this.state.approvers.find(
        (other) =>
          other.userId === slot.userId &&
          other.status === 'approved' &&
          this.state.steps.some(
            (candidate) =>
              candidate.id === other.stepId &&
              candidate.round === step.round &&
              candidate.nodeId !== step.nodeId &&
              candidate.status !== 'returned',
          ),
      );
      if (!earlier) continue;
      const fromStepId = earlier.autoFromStep ?? earlier.stepId;
      slot.status = 'approved';
      slot.decidedAt = this.now;
      slot.autoFromStep = fromStepId;
      const entry = byUser.get(slot.userId) ?? { groupIds: [], fromStepId };
      entry.groupIds.push(slot.groupId);
      byUser.set(slot.userId, entry);
    }
    for (const [userId, { groupIds, fromStepId }] of byUser) {
      this.record('auto_approved', { step, metadata: { userId, groupIds, fromStepId } });
    }
  }

  // ---------------------------------------------------------------------------------------
  // Approver resolution
  // ---------------------------------------------------------------------------------------

  /** What resolvers get to know about the instance (copies, so changes are ignored). */
  private instanceContext(nodeId: string): Omit<ResolverContext, 'groupId'> {
    return {
      requester: { id: this.instance.requesterId },
      subject: { ...this.instance.subject },
      document: clone(this.instance.document),
      instance: clone(this.instance),
      nodeId,
    };
  }

  /** Resolves entries into users (first source wins), applying the group's filters. */
  private async resolveEntries(
    nodeId: string,
    groupId: string,
    excludeRequester: boolean,
    entries: readonly ApproverEntry[],
    taken: ReadonlySet<string>,
    exclusive: boolean,
  ): Promise<Map<string, ApproverEntry | null>> {
    const users = new Map<string, ApproverEntry | null>();
    for (const entry of entries) {
      const resolver = this.services.approverTypes.get(entry.type);
      if (!resolver) {
        throw new UnknownApproverTypeError(entry.type, this.stepEntryContext(nodeId, groupId));
      }
      const ids = await resolver(clone(entry), { ...this.instanceContext(nodeId), groupId });
      for (const id of ids) {
        if (typeof id !== 'string' || id === '' || users.has(id)) continue;
        if (excludeRequester && id === this.instance.requesterId) continue;
        if (exclusive && taken.has(id)) continue;
        users.set(id, clone(entry));
      }
    }
    return users;
  }

  private resolveCandidates(
    step: Step,
    group: GroupDefinition,
    taken: ReadonlySet<string>,
    countAcrossGroups: boolean,
  ): Promise<Map<string, ApproverEntry | null>> {
    return this.resolveEntries(
      step.nodeId,
      group.id,
      group.excludeRequester ?? false,
      group.approvers,
      taken,
      !countAcrossGroups,
    );
  }

  /**
   * Applies `onEmptyApprovers` and `onInsufficientApprovers`. `kept` are users who stay in the
   * group regardless (decisions kept by a re-resolve).
   */
  private async applyPolicies(
    step: Step,
    group: GroupDefinition,
    candidates: Map<string, ApproverEntry | null>,
    kept: ReadonlySet<string>,
  ): Promise<GroupResolution> {
    const context = this.stepEntryContext(step.nodeId, group.id);
    const users = new Map(candidates);
    const notes: JsonObject = {};
    const size = () => new Set([...users.keys(), ...kept]).size;
    const fallback = async () =>
      this.resolveEntries(
        step.nodeId,
        group.id,
        group.excludeRequester ?? false,
        group.fallbackApprovers ?? [],
        new Set(),
        false,
      );

    if (size() === 0) {
      const policy = group.onEmptyApprovers ?? 'error';
      if (policy === 'skip') return { users, status: 'skipped', notes };
      if (policy === 'fallback') {
        for (const [userId, source] of await fallback()) users.set(userId, source);
        notes.fallback = 'empty';
      }
      if (size() === 0) throw new EmptyApproversError(context);
    }

    if (typeof group.mode !== 'object' || size() >= group.mode.minimum) {
      return { users, status: 'pending', notes };
    }
    const minimum = group.mode.minimum;
    const policy = group.onInsufficientApprovers ?? 'error';
    if (policy === 'cap') {
      notes.cappedMinimum = size();
      return { users, status: 'pending', minimum: size(), notes };
    }
    if (policy === 'fallback') {
      for (const [userId, source] of await fallback()) {
        if (size() >= minimum) break;
        if (!users.has(userId) && !kept.has(userId)) users.set(userId, source);
      }
      notes.fallback = 'insufficient';
      if (size() >= minimum) return { users, status: 'pending', notes };
    }
    throw new InsufficientApproversError(size(), minimum, context);
  }

  // ---------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------

  activeStep(): Step | undefined {
    const id = this.instance.currentStepId;
    return id === null ? undefined : this.state.steps.find((step) => step.id === id);
  }

  private requireRunning(): void {
    const { status } = this.instance;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'returned') {
      throw new InvalidStateError(`The instance is already ${status}`, this.context);
    }
  }

  private requireActiveStep(): Step {
    this.requireRunning();
    const step = this.activeStep();
    if (!step) {
      throw new InvalidStateError(
        `The instance has no active step (status "${this.instance.status}")`,
        this.context,
      );
    }
    return step;
  }

  private stepNode(nodeId: string): StepNode {
    const node = this.flow.nodes[nodeId];
    if (node?.type !== 'approval' && node?.type !== 'approval-chain') {
      throw new ParafError('UNKNOWN_NODE', `Node "${nodeId}" is not an approval node.`);
    }
    return node;
  }

  private nextIteration(nodeId: string): number {
    const visits = this.state.steps.filter((step) => step.nodeId === nodeId);
    return Math.max(0, ...visits.map((step) => step.iteration)) + 1;
  }

  /** Adds an active step; its `dueAt` comes from the node's `timeout`. */
  private newStep(nodeId: string, iteration: number, chainLevel: number, config: StepConfig): Step {
    const timeout = this.stepNode(nodeId).timeout;
    const duration = timeout && parseDuration(timeout.after);
    const step: Step = {
      id: this.services.generateId(),
      instanceId: this.instance.id,
      nodeId,
      iteration,
      chainLevel,
      round: this.instance.round,
      status: 'active',
      config,
      enteredAt: this.now,
      dueAt: duration ? addDuration(this.now, duration) : null,
      completedAt: null,
    };
    this.state.steps.push(step);
    return step;
  }

  private stepEntryContext(nodeId: string, groupId: string): StepEntryErrorContext {
    return { ...this.context, nodeId, groupId };
  }

  private groupConfig(step: Step, groupId: string): StepGroupConfig {
    const group = step.config.groups.find((candidate) => candidate.id === groupId);
    if (!group) throw new ParafError('UNKNOWN_GROUP', `Step has no group "${groupId}".`);
    return group;
  }

  private slotsOf(step: Step): ApproverSlot[] {
    return this.state.approvers.filter((slot) => slot.stepId === step.id);
  }

  private pendingSlots(step: Step, userId: string): ApproverSlot[] {
    return this.slotsOf(step).filter((slot) => slot.userId === userId && slot.status === 'pending');
  }

  private newSlot(
    step: Step,
    groupId: string,
    userId: string,
    source: ApproverEntry | null,
    delegatedFrom: string | null,
  ): ApproverSlot {
    return {
      id: this.services.generateId(),
      stepId: step.id,
      instanceId: this.instance.id,
      groupId,
      userId,
      source,
      status: 'pending',
      delegatedFrom,
      autoFromStep: null,
      decidedAt: null,
      comment: null,
    };
  }

  private removeSlot(slot: ApproverSlot): void {
    this.state.approvers.splice(this.state.approvers.indexOf(slot), 1);
  }

  private markInProgress(): void {
    if (this.instance.status === 'pending') this.instance.status = 'in_progress';
  }

  private requiredFor(group: StepGroupConfig, userIds: string[]): RequiredApprovers {
    return {
      groupId: group.id,
      ...(group.label === undefined ? {} : { label: group.label }),
      userIds,
    };
  }

  private recordReresolved(
    step: Step,
    actorId: string,
    added: ApproverChange[],
    removed: ApproverChange[],
  ): void {
    this.record('reresolved', {
      step,
      actorId,
      metadata: {
        added: added.map((change) => ({ ...change })),
        removed: removed.map((change) => ({ ...change })),
      },
    });
    this.emit('approvers.reresolved', () => ({
      instance: clone(this.instance),
      step: clone(step),
      added,
      removed,
    }));
    const notify = step.config.groups
      .map((group) =>
        this.requiredFor(
          group,
          added.filter((change) => change.groupId === group.id).map((change) => change.userId),
        ),
      )
      .filter((entry) => entry.userIds.length > 0);
    if (notify.length > 0) this.emitApprovalRequired(step, 'reresolved', notify);
  }

  private emitApprovalRequired(
    step: Step,
    reason: ParafEvents['approval.required']['reason'],
    groups: RequiredApprovers[],
  ): void {
    this.emit('approval.required', () => ({
      instance: clone(this.instance),
      step: clone(step),
      reason,
      groups: clone(groups),
    }));
  }

  private emit<E extends ParafEventName>(name: E, payload: () => ParafEvents[E]): void {
    this.queued.push(() => ({ name, payload: payload() }));
  }

  private record(
    action: AuditAction,
    entry: {
      step?: Step | undefined;
      nodeId?: string;
      actorId?: string | null;
      comment?: string | null;
      metadata?: JsonObject;
    },
  ): void {
    this.audit.push({
      id: this.services.generateId(),
      instanceId: this.instance.id,
      stepId: entry.step?.id ?? null,
      nodeId: entry.step?.nodeId ?? entry.nodeId ?? null,
      action,
      actorId: entry.actorId ?? null,
      comment: entry.comment ?? null,
      timestamp: this.now,
      metadata: entry.metadata ?? null,
    });
  }
}
