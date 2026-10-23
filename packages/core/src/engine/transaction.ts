import { evaluateCondition, isTruthy } from '../condition/evaluate';
import type { OperatorFunction } from '../condition/evaluate';
import {
  DelegationError,
  EmptyApproversError,
  InsufficientApproversError,
  InvalidArgumentError,
  InvalidStateError,
  NotAuthorizedError,
  NotImplementedError,
  ParafError,
  UnknownApproverTypeError,
} from '../errors';
import type { ActionErrorContext } from '../errors';
import type {
  ApprovalNode,
  ApproverEntry,
  ApproverGroupRules,
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
  StepGroupConfig,
  StepStatus,
} from '../types/instance';
import type { JsonObject } from '../types/json';
import type { IdGenerator } from '../uuid';
import { clone } from '../utils/clone';
import { countedSlots, evaluateStep, requiredApprovals } from './evaluate-step';
import type {
  ApproverChange,
  ParafEventName,
  ParafEvents,
  QueuedEvent,
  RequiredApprovers,
} from './events';
import type { ApproverTypeRegistry, ResolverContext } from './registry';

/** Engine parts a transaction needs. */
export interface TransactionServices {
  approverTypes: ApproverTypeRegistry;
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

const SINGLE_GROUP_ID = 'default';

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
    if (document !== undefined) this.instance.document = clone(document);
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
    const node = this.approvalNode(step.nodeId);
    const added: ApproverChange[] = [];
    const removed: ApproverChange[] = [];
    const taken = new Set<string>();

    for (const definition of groupsOf(node)) {
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
          this.state.approvers.splice(this.state.approvers.indexOf(slot), 1);
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
          added.filter((c) => c.groupId === group.id).map((c) => c.userId),
        ),
      )
      .filter((entry) => entry.userIds.length > 0);
    if (notify.length > 0) this.emitApprovalRequired(step, 'reresolved', notify);
    await this.settle(step);
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
        throw new NotImplementedError(
          `Node "${nodeId}" is an approval-chain node, which is not supported yet.`,
        );
    }
  }

  private async enterApproval(nodeId: string, node: ApprovalNode): Promise<void> {
    const iteration =
      Math.max(0, ...this.state.steps.filter((s) => s.nodeId === nodeId).map((s) => s.iteration)) +
      1;
    const step: Step = {
      id: this.services.generateId(),
      instanceId: this.instance.id,
      nodeId,
      iteration,
      chainLevel: 0,
      round: this.instance.round,
      status: 'active',
      config: {
        require: node.require ?? 'all',
        countAcrossGroups: node.countAcrossGroups ?? true,
        groups: [],
      },
      enteredAt: this.now,
      dueAt: null,
      completedAt: null,
    };
    this.state.steps.push(step);
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

    this.record('step_entered', { step, metadata: { iteration, groups: summary } });
    for (const group of step.config.groups) {
      if (group.status === 'skipped') {
        this.record('skipped', { step, metadata: { groupId: group.id, reason: 'no_approvers' } });
      }
    }
    this.emit('step.entered', () => ({ instance: clone(this.instance), step: clone(step) }));

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
    const node = this.approvalNode(step.nodeId);
    await this.enterNode(outcome === 'approved' ? node.next : node.onReject);
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
  // Approver resolution
  // ---------------------------------------------------------------------------------------

  private resolverContext(step: Step, groupId: string): ResolverContext {
    return {
      requester: { id: this.instance.requesterId },
      subject: { ...this.instance.subject },
      document: clone(this.instance.document),
      instance: clone(this.instance),
      nodeId: step.nodeId,
      groupId,
    };
  }

  /** Resolves entries into users (first source wins), applying the group's filters. */
  private async resolveEntries(
    step: Step,
    group: GroupDefinition,
    entries: readonly ApproverEntry[],
    taken: ReadonlySet<string>,
    exclusive: boolean,
  ): Promise<Map<string, ApproverEntry | null>> {
    const users = new Map<string, ApproverEntry | null>();
    for (const entry of entries) {
      const resolver = this.services.approverTypes.get(entry.type);
      if (!resolver) {
        throw new UnknownApproverTypeError(entry.type, {
          ...this.context,
          nodeId: step.nodeId,
          groupId: group.id,
        });
      }
      const ids = await resolver(clone(entry), this.resolverContext(step, group.id));
      for (const id of ids) {
        if (typeof id !== 'string' || id === '' || users.has(id)) continue;
        if (group.excludeRequester && id === this.instance.requesterId) continue;
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
    return this.resolveEntries(step, group, group.approvers, taken, !countAcrossGroups);
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
    const context = { ...this.context, nodeId: step.nodeId, groupId: group.id };
    const users = new Map(candidates);
    const notes: JsonObject = {};
    const size = () => new Set([...users.keys(), ...kept]).size;
    const fallback = async () =>
      this.resolveEntries(step, group, group.fallbackApprovers ?? [], new Set(), false);

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

  private approvalNode(nodeId: string): ApprovalNode {
    const node = this.flow.nodes[nodeId];
    if (node?.type !== 'approval') {
      throw new ParafError('UNKNOWN_NODE', `Node "${nodeId}" is not an approval node.`);
    }
    return node;
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
