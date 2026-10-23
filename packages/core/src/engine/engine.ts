import { BUILTIN_OPERATORS } from '../condition/operators';
import type { OperatorFunction } from '../condition/evaluate';
import {
  ConcurrencyError,
  DocumentValidationError,
  FlowNotFoundError,
  FlowValidationError,
  FlowVersionExistsError,
  InstanceNotFoundError,
  InvalidArgumentError,
  StepEntryError,
} from '../errors';
import type { ActionErrorContext } from '../errors';
import type {
  FlowSummary,
  FlowVersionInfo,
  InstanceQuery,
  PageQuery,
  Paginated,
  ParafStore,
  PendingItem,
} from '../store/types';
import type { FlowDefinition, PublishedFlow, ResubmitPolicy } from '../types/flow';
import type { AuditEntry, Instance, InstanceState, Subject } from '../types/instance';
import type { JsonObject } from '../types/json';
import { validateDocument } from '../document';
import { clone } from '../utils/clone';
import { uuidv7 } from '../uuid';
import type { IdGenerator } from '../uuid';
import { validateFlow } from '../validation/validate-flow';
import { EventBus } from './events';
import type { EventErrorHandler, ParafEventHandler, ParafEventName } from './events';
import { ApproverTypeRegistry, ChainRegistry } from './registry';
import type {
  ApproverResolver,
  ApproverTypeInfo,
  ApproverTypeMeta,
  ChainInfo,
  ChainMeta,
  ChainResolver,
} from './registry';
import { Transaction } from './transaction';
import type { TransactionServices } from './transaction';

/** Decides whether a user may perform admin actions on an instance. */
export type AdminCheck = (
  userId: string,
  context: { instance: Instance },
) => boolean | Promise<boolean>;

/** Options of {@link createEngine}. */
export interface EngineOptions {
  /** Where flows, instances, and the audit trail are stored. */
  store: ParafStore;
  /** ID generator for instances, steps, approver slots, and audit entries. Default UUID v7. */
  generateId?: IdGenerator;
  /** Clock. Default `() => new Date()`. */
  now?: () => Date;
  /**
   * Who counts as admin (may cancel any instance, re-resolve approvers, and return any
   * instance). Default: nobody.
   */
  isAdmin?: AdminCheck;
  /** Called when an event handler throws. Default: `console.error`. */
  onEventError?: EventErrorHandler;
  /** How often an action is retried after a concurrent update. Default 3. */
  maxRetries?: number;
}

/** Input of {@link ParafEngine.start}. */
export interface StartOptions {
  /** The application document being approved. */
  subject: Subject;
  requester: { id: string };
  /** Data conditions and resolvers read. Default `{}`. */
  document?: JsonObject;
}

/** Options of {@link ParafEngine.returnForRevision}. */
export interface ReturnOptions {
  /** Send back to this node (visited earlier in the current round) instead of the requester. */
  toNodeId?: string;
  /** Override the flow's `resubmitPolicy` for this return. */
  resubmitPolicy?: ResubmitPolicy;
}

/** Outcome of {@link ParafEngine.processTimeouts}. */
export interface TimeoutResult {
  /** Steps that were escalated. */
  escalated: { instanceId: string; stepId: string }[];
  /** Instances that could not be processed, with the error. */
  failed: { instanceId: string; error: unknown }[];
}

/** Options of {@link ParafEngine.publishFlow}. */
export interface PublishOptions {
  /** Who published the version. */
  createdBy?: string;
  /** Release notes: what changed and why. */
  notes?: string;
}

function defaultEventError(error: unknown, event: { name: ParafEventName }): void {
  console.error(`Paraf: a handler of "${event.name}" failed.`, error);
}

function requireText(value: unknown, name: string, context: ActionErrorContext): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidArgumentError(`"${name}" must be a non-empty string`, context);
  }
}

/** Creates an approval engine. */
export function createEngine(options: EngineOptions): ParafEngine {
  return new ParafEngine(options);
}

/**
 * Runs approval flows. Stateless apart from its registries: all instance data lives in the
 * store, so several engine instances (processes) can share one store.
 */
export class ParafEngine {
  private readonly store: ParafStore;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly approverTypes = new ApproverTypeRegistry();
  private readonly chains = new ChainRegistry();
  private readonly operators = new Map<string, OperatorFunction>();
  private readonly events: EventBus;
  private readonly flowCache = new Map<string, PublishedFlow>();
  private readonly services: TransactionServices;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = (options.maxRetries ?? 3) + 1;
    this.events = new EventBus(options.onEventError ?? defaultEventError);
    const isAdmin = options.isAdmin;
    this.services = {
      approverTypes: this.approverTypes,
      chains: this.chains,
      operators: this.operators,
      generateId: options.generateId ?? uuidv7,
      isAdmin: async (userId, state) =>
        isAdmin ? await isAdmin(userId, { instance: clone(state.instance) }) : false,
    };
  }

  // ---------------------------------------------------------------------------------------
  // Registries
  // ---------------------------------------------------------------------------------------

  /**
   * Registers how to find approvers of a type, e.g. `role`. Replaces an existing registration
   * of the same type. `meta` lets the editor build a configuration form.
   */
  registerApproverType(type: string, resolver: ApproverResolver, meta?: ApproverTypeMeta): void {
    this.approverTypes.register(type, resolver, meta);
  }

  /** Registered approver types (including the built-in `user` and `field`) with metadata. */
  getApproverTypes(): ApproverTypeInfo[] {
    return this.approverTypes.list();
  }

  /**
   * Registers a chain for `approval-chain` nodes: how to find the next user up from a user,
   * e.g. their supervisor. Return `null` at the top. Replaces a chain of the same name.
   */
  registerChain(name: string, resolver: ChainResolver, meta?: ChainMeta): void {
    this.chains.register(name, resolver, meta);
  }

  /** Registered chains with metadata, for the editor. */
  getChains(): ChainInfo[] {
    return this.chains.list();
  }

  /** Adds a condition operator, e.g. `startsWith`. Built-in operators cannot be replaced. */
  registerOperator(name: string, operator: OperatorFunction): void {
    if (name === '' || name === 'var' || name in BUILTIN_OPERATORS) {
      throw new InvalidArgumentError(`"${name}" cannot be registered as an operator`, {
        action: 'registerOperator',
      });
    }
    this.operators.set(name, operator);
  }

  /** Names of the registered custom operators (for `validateFlow` and the editor). */
  getOperators(): string[] {
    return [...this.operators.keys()];
  }

  /** Subscribes to an engine event; returns a function that unsubscribes. */
  on<E extends ParafEventName>(name: E, handler: ParafEventHandler<E>): () => void {
    return this.events.on(name, handler);
  }

  // ---------------------------------------------------------------------------------------
  // Flows
  // ---------------------------------------------------------------------------------------

  /**
   * Validates the flow against the registered approver types and operators, stores it as a new
   * version (never overwriting an old one), and makes that version active.
   *
   * @returns the stored definition with its assigned `version`.
   * @throws FlowValidationError when the flow is invalid.
   */
  async publishFlow(flow: FlowDefinition, options: PublishOptions = {}): Promise<PublishedFlow> {
    const issues = validateFlow(flow, {
      approverTypes: this.approverTypes.names(),
      chains: this.chains.names(),
      operators: [...this.operators.keys()],
    });
    if (issues.length > 0) throw new FlowValidationError(flow.id, issues);

    for (let attempt = 1; ; attempt++) {
      const summary = (await this.store.listFlows()).find((entry) => entry.id === flow.id);
      const definition: PublishedFlow = {
        ...clone(flow),
        version: (summary?.latestVersion ?? 0) + 1,
      };
      try {
        await this.store.saveFlowVersion(definition, {
          ...(options.createdBy === undefined ? {} : { createdBy: options.createdBy }),
          ...(options.notes === undefined ? {} : { notes: options.notes }),
        });
      } catch (error) {
        if (error instanceof FlowVersionExistsError && attempt < this.maxAttempts) continue;
        throw error;
      }
      await this.store.setActiveVersion(flow.id, definition.version);
      return clone(definition);
    }
  }

  /** Makes an existing version the one new instances use (e.g. to roll back). */
  async activateFlowVersion(flowId: string, version: number): Promise<void> {
    await this.getFlowVersion(flowId, version);
    await this.store.setActiveVersion(flowId, version);
  }

  /** The version new instances of the flow use, or `null`. */
  getActiveFlow(flowId: string): Promise<PublishedFlow | null> {
    return this.store.getActiveFlow(flowId);
  }

  /** A specific version of a flow, or `null`. */
  getFlow(flowId: string, version: number): Promise<PublishedFlow | null> {
    return this.store.getFlowVersion(flowId, version);
  }

  /** All stored flows with their active and latest versions. */
  listFlows(): Promise<FlowSummary[]> {
    return this.store.listFlows();
  }

  /** The versions of a flow (newest first) with who published them, when, and their notes. */
  listFlowVersions(flowId: string): Promise<FlowVersionInfo[]> {
    return this.store.listFlowVersions(flowId);
  }

  // ---------------------------------------------------------------------------------------
  // Instance actions
  // ---------------------------------------------------------------------------------------

  /**
   * Starts the active version of a flow for an application document. Only one instance per
   * subject can be active at a time.
   *
   * @throws ActiveInstanceExistsError when the subject already has an active instance.
   */
  async start(flowId: string, options: StartOptions): Promise<Instance> {
    const context: ActionErrorContext = { action: 'start', userId: options.requester.id };
    requireText(options.subject.type, 'subject.type', context);
    requireText(options.subject.id, 'subject.id', context);
    requireText(options.requester.id, 'requester.id', context);

    const flow = await this.store.getActiveFlow(flowId);
    if (!flow) throw new FlowNotFoundError(flowId);
    const problems = validateDocument(options.document ?? {}, flow.variables);
    if (problems.length > 0) throw new DocumentValidationError(problems, context);
    const { version } = flow;
    this.flowCache.set(`${flowId}@${version}`, flow);

    const now = this.now();
    const instance: Instance = {
      id: this.services.generateId(),
      flowId,
      flowVersion: version,
      subject: { type: options.subject.type, id: options.subject.id },
      requesterId: options.requester.id,
      status: 'pending',
      currentStepId: null,
      round: 1,
      document: clone(options.document ?? {}),
      revision: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const tx = new Transaction({ instance, steps: [], approvers: [] }, flow, now, this.services, {
      ...context,
      instanceId: instance.id,
    });
    await tx.start();
    await this.store.createInstance(tx.state, tx.audit);
    await this.events.emit(tx.events());
    return clone(tx.instance);
  }

  /** Approves as a pending approver of the active step (in every group the user is in). */
  approve(instanceId: string, userId: string, comment?: string): Promise<Instance> {
    return this.run('approve', instanceId, userId, (tx) =>
      tx.decide(userId, 'approved', comment ?? null),
    );
  }

  /** Rejects as a pending approver of the active step. A comment is required. */
  reject(instanceId: string, userId: string, comment: string): Promise<Instance> {
    return this.run('reject', instanceId, userId, (tx) => {
      requireText(comment, 'comment', tx.context);
      return tx.decide(userId, 'rejected', comment);
    });
  }

  /**
   * Returns the active step for revision: to the requester (default; the instance becomes
   * `returned` until `resubmit`) or to a node visited earlier in the current round.
   * Allowed for pending approvers of the active step and admins.
   */
  returnForRevision(
    instanceId: string,
    userId: string,
    comment: string,
    options: ReturnOptions = {},
  ): Promise<Instance> {
    return this.run('returnForRevision', instanceId, userId, (tx) => {
      requireText(comment, 'comment', tx.context);
      return tx.returnForRevision(userId, comment, options);
    });
  }

  /**
   * Resubmits a returned instance (requester only), optionally replacing its document. Starts a
   * new round from the start node (`restart`) or from the node that returned it (`resume`).
   */
  resubmit(instanceId: string, userId: string, document?: JsonObject): Promise<Instance> {
    return this.run('resubmit', instanceId, userId, (tx) => tx.resubmit(userId, document));
  }

  /**
   * Moves `fromUserId`'s vote on the active step to `toUserId`, in every group where
   * `fromUserId` is a pending approver. If `toUserId` is already an approver of a group, they
   * keep a single vote there and the group has one approver less.
   *
   * @throws DelegationError when a group's minimum would become unreachable.
   */
  delegate(
    instanceId: string,
    fromUserId: string,
    toUserId: string,
    reason?: string,
  ): Promise<Instance> {
    return this.run('delegate', instanceId, fromUserId, (tx) =>
      tx.delegate(fromUserId, toUserId, reason ?? null),
    );
  }

  /** Cancels a running instance. Allowed for the requester and admins. */
  cancel(instanceId: string, userId: string, reason?: string): Promise<Instance> {
    return this.run('cancel', instanceId, userId, (tx) => tx.cancel(userId, reason ?? null));
  }

  /**
   * Resolves the active step's approvers again (admins only), e.g. after role membership
   * changed. Decisions already made are kept; pending approvers no longer resolved are removed
   * and new ones added. The step is then re-evaluated.
   */
  reresolveApprovers(instanceId: string, actorId: string): Promise<Instance> {
    return this.run('reresolveApprovers', instanceId, actorId, (tx) => tx.reresolve(actorId));
  }

  /**
   * Escalates every step whose `due_at` has passed (see the node's `timeout`). The engine runs
   * no timers: call this periodically from a cron job, queue, or scheduler. Each step escalates
   * once. A failure on one instance does not stop the others; it is reported in `failed`.
   *
   * @param now the current time. Default: the engine clock.
   */
  async processTimeouts(now: Date = this.now()): Promise<TimeoutResult> {
    const result: TimeoutResult = { escalated: [], failed: [] };
    for (const { instance } of await this.store.findTimedOut(now)) {
      const outcome = { escalated: false, stepId: '' };
      try {
        await this.run(
          'processTimeouts',
          instance.id,
          null,
          async (tx) => {
            outcome.stepId = tx.instance.currentStepId ?? '';
            outcome.escalated = await tx.escalate(now);
            return outcome.escalated;
          },
          now,
        );
        if (outcome.escalated) {
          result.escalated.push({ instanceId: instance.id, stepId: outcome.stepId });
        }
      } catch (error) {
        result.failed.push({ instanceId: instance.id, error });
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------

  /** An instance with its steps and approver slots, or `null`. */
  getInstance(instanceId: string): Promise<InstanceState | null> {
    return this.store.getInstance(instanceId);
  }

  /** Instances by subject, status, and/or flow, newest first. */
  findInstances(query: InstanceQuery): Promise<Paginated<Instance>> {
    return this.store.findInstances(query);
  }

  /** Steps waiting for the user's decision (their inbox), oldest first. */
  findPendingForUser(userId: string, page?: PageQuery): Promise<Paginated<PendingItem>> {
    return this.store.findPendingForUser(userId, page);
  }

  /** The audit trail of an instance, oldest first. */
  getHistory(instanceId: string): Promise<AuditEntry[]> {
    return this.store.getAudit(instanceId);
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  private async getFlowVersion(flowId: string, version: number): Promise<PublishedFlow> {
    const key = `${flowId}@${version}`;
    const cached = this.flowCache.get(key);
    if (cached) return cached;
    const flow = await this.store.getFlowVersion(flowId, version);
    if (!flow) throw new FlowNotFoundError(flowId, version);
    this.flowCache.set(key, flow);
    return flow;
  }

  /**
   * Runs an action with optimistic locking: load, apply on a copy, save if nobody changed the
   * instance meanwhile, otherwise retry. Events are emitted after a successful save. When
   * `apply` returns `false` there is nothing to save.
   */
  private async run(
    action: string,
    instanceId: string,
    userId: string | null,
    apply: (tx: Transaction) => Promise<unknown>,
    at?: Date,
  ): Promise<Instance> {
    const context: ActionErrorContext = {
      action,
      instanceId,
      ...(userId === null ? {} : { userId }),
    };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const state = await this.store.getInstance(instanceId);
      if (!state) throw new InstanceNotFoundError(instanceId);
      const flow = await this.getFlowVersion(state.instance.flowId, state.instance.flowVersion);
      const expectedRevision = state.instance.revision;
      const tx = new Transaction(state, flow, at ?? this.now(), this.services, context);

      let changed: unknown;
      try {
        changed = await apply(tx);
      } catch (error) {
        if (error instanceof StepEntryError) await this.recordStepFailure(tx, error, userId);
        throw error;
      }
      if (changed === false) return clone(tx.instance);

      tx.instance.revision = expectedRevision + 1;
      tx.instance.updatedAt = tx.now;
      if (await this.store.updateInstance(tx.state, expectedRevision, tx.audit)) {
        await this.events.emit(tx.events());
        return clone(tx.instance);
      }
    }
    throw new ConcurrencyError(this.maxAttempts, context);
  }

  /** Records a failed step entry outside the rolled-back action. */
  private async recordStepFailure(
    tx: Transaction,
    error: StepEntryError,
    userId: string | null,
  ): Promise<void> {
    await this.store.appendAudit([
      {
        id: this.services.generateId(),
        instanceId: tx.instance.id,
        stepId: null,
        nodeId: error.context.nodeId,
        action: 'step_failed',
        actorId: userId,
        comment: null,
        timestamp: tx.now,
        metadata: { code: error.code, message: error.message, groupId: error.context.groupId },
      },
    ]);
  }
}
