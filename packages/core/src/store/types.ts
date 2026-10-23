import type { PublishedFlow } from '../types/flow';
import type { AuditEntry, Instance, InstanceState, InstanceStatus } from '../types/instance';

/** One stored flow with its versions. */
export interface FlowSummary {
  id: string;
  /** Name of the latest version. */
  name: string;
  /** Version new instances use, or `null` if none is active. */
  activeVersion: number | null;
  latestVersion: number;
}

/** Metadata stored with a flow version. */
export interface FlowVersionMeta {
  /** Who published the version. */
  createdBy?: string;
  /** Release notes: what changed and why. */
  notes?: string;
}

/** One stored version of a flow, without its definition. */
export interface FlowVersionInfo {
  version: number;
  /** The flow's name in this version. */
  name: string;
  createdBy: string | null;
  notes: string | null;
  createdAt: Date;
}

/** Offset pagination. */
export interface PageQuery {
  /** Maximum number of items. Default 50. */
  limit?: number;
  /** Number of items to skip. Default 0. */
  offset?: number;
}

/** One page of results. */
export interface Paginated<T> {
  items: T[];
  /** Number of matching items across all pages. */
  total: number;
}

/** Filters for {@link ParafStore.findInstances}. All given filters must match. */
export interface InstanceQuery extends PageQuery {
  /** Match one subject, or every subject of a type when `id` is omitted. */
  subject?: { type: string; id?: string };
  status?: InstanceStatus | InstanceStatus[];
  flowId?: string;
}

/** A step waiting for a user's decision (one inbox row). */
export interface PendingItem {
  instance: Instance;
  stepId: string;
  nodeId: string;
  /** Groups in which the user is a pending approver. */
  groupIds: string[];
  enteredAt: Date;
  dueAt: Date | null;
}

/**
 * Persistence used by the engine. Implementations: `MemoryStore` (in core), `@paraf/postgres`,
 * `@paraf/mysql`.
 *
 * Contract:
 * - Flow versions are immutable; `saveFlowVersion` throws `FlowVersionExistsError` when the
 *   version already exists.
 * - `createInstance` and `updateInstance` store the instance, its steps and approver slots, and
 *   the audit entries of the same action atomically.
 * - At most one instance per subject may be active (`pending`, `in_progress`, `returned`);
 *   violations throw `ActiveInstanceExistsError` and are enforced by the storage itself.
 * - `updateInstance` applies only when the stored revision equals `expectedRevision`, and
 *   returns `false` (changing nothing) otherwise.
 * - Returned objects must not be shared with the store's internal state.
 */
export interface ParafStore {
  saveFlowVersion(flow: PublishedFlow, meta?: FlowVersionMeta): Promise<void>;
  setActiveVersion(flowId: string, version: number): Promise<void>;
  getFlowVersion(flowId: string, version: number): Promise<PublishedFlow | null>;
  getActiveFlow(flowId: string): Promise<PublishedFlow | null>;
  listFlows(): Promise<FlowSummary[]>;
  /** Versions of one flow, newest first; empty when the flow does not exist. */
  listFlowVersions(flowId: string): Promise<FlowVersionInfo[]>;

  createInstance(state: InstanceState, audit: AuditEntry[]): Promise<void>;
  getInstance(id: string): Promise<InstanceState | null>;
  updateInstance(
    state: InstanceState,
    expectedRevision: number,
    audit: AuditEntry[],
  ): Promise<boolean>;
  findInstances(query: InstanceQuery): Promise<Paginated<Instance>>;
  findPendingForUser(userId: string, page?: PageQuery): Promise<Paginated<PendingItem>>;
  findTimedOut(now: Date): Promise<InstanceState[]>;

  appendAudit(entries: AuditEntry[]): Promise<void>;
  getAudit(instanceId: string): Promise<AuditEntry[]>;
}
