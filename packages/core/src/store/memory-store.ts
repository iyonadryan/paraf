import { ActiveInstanceExistsError, FlowNotFoundError, FlowVersionExistsError } from '../errors';
import type { PublishedFlow } from '../types/flow';
import { ACTIVE_INSTANCE_STATUSES } from '../types/instance';
import type { AuditEntry, Instance, InstanceState } from '../types/instance';
import { clone } from '../utils/clone';
import type {
  FlowSummary,
  FlowVersionInfo,
  FlowVersionMeta,
  InstanceQuery,
  PageQuery,
  Paginated,
  ParafStore,
  PendingItem,
} from './types';

const DEFAULT_LIMIT = 50;

interface StoredVersion {
  flow: PublishedFlow;
  createdBy: string | null;
  notes: string | null;
  createdAt: Date;
}

function paginate<T>(items: T[], page: PageQuery = {}): Paginated<T> {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? DEFAULT_LIMIT;
  return { items: items.slice(offset, offset + limit), total: items.length };
}

function isActive(instance: Instance): boolean {
  return ACTIVE_INSTANCE_STATUSES.includes(instance.status);
}

/**
 * In-memory {@link ParafStore} for tests, examples, and prototypes. Data lives in the process
 * and is lost on restart. Every read and write copies data, so callers never share state with
 * the store.
 */
export class MemoryStore implements ParafStore {
  private readonly flows = new Map<string, Map<number, StoredVersion>>();
  private readonly heads = new Map<string, number>();
  private readonly instances = new Map<string, InstanceState>();
  private readonly audit: AuditEntry[] = [];

  saveFlowVersion(flow: PublishedFlow, meta: FlowVersionMeta = {}): Promise<void> {
    const { version } = flow;
    const versions = this.flows.get(flow.id) ?? new Map<number, StoredVersion>();
    if (versions.has(version)) return Promise.reject(new FlowVersionExistsError(flow.id, version));
    versions.set(version, {
      flow: clone(flow),
      createdBy: meta.createdBy ?? null,
      notes: meta.notes ?? null,
      createdAt: new Date(),
    });
    this.flows.set(flow.id, versions);
    return Promise.resolve();
  }

  setActiveVersion(flowId: string, version: number): Promise<void> {
    if (!this.flows.get(flowId)?.has(version)) {
      return Promise.reject(new FlowNotFoundError(flowId, version));
    }
    this.heads.set(flowId, version);
    return Promise.resolve();
  }

  getFlowVersion(flowId: string, version: number): Promise<PublishedFlow | null> {
    const stored = this.flows.get(flowId)?.get(version);
    return Promise.resolve(stored ? clone(stored.flow) : null);
  }

  getActiveFlow(flowId: string): Promise<PublishedFlow | null> {
    const version = this.heads.get(flowId);
    return version === undefined ? Promise.resolve(null) : this.getFlowVersion(flowId, version);
  }

  listFlows(): Promise<FlowSummary[]> {
    const summaries: FlowSummary[] = [];
    for (const [id, versions] of this.flows) {
      const latest = [...versions.values()]
        .map((stored) => stored.flow)
        .reduce((a, b) => (b.version > a.version ? b : a));
      summaries.push({
        id,
        name: latest.name,
        activeVersion: this.heads.get(id) ?? null,
        latestVersion: latest.version,
      });
    }
    return Promise.resolve(summaries.sort((a, b) => a.id.localeCompare(b.id)));
  }

  listFlowVersions(flowId: string): Promise<FlowVersionInfo[]> {
    const versions = [...(this.flows.get(flowId)?.values() ?? [])].map(
      ({ flow, createdBy, notes, createdAt }): FlowVersionInfo => ({
        version: flow.version,
        name: flow.name,
        createdBy,
        notes,
        createdAt: new Date(createdAt),
      }),
    );
    return Promise.resolve(versions.sort((a, b) => b.version - a.version));
  }

  createInstance(state: InstanceState, audit: AuditEntry[]): Promise<void> {
    const conflict = this.findActiveConflict(state.instance);
    if (conflict) return Promise.reject(new ActiveInstanceExistsError(state.instance.subject));
    this.instances.set(state.instance.id, clone(state));
    this.audit.push(...clone(audit));
    return Promise.resolve();
  }

  getInstance(id: string): Promise<InstanceState | null> {
    const state = this.instances.get(id);
    return Promise.resolve(state ? clone(state) : null);
  }

  updateInstance(
    state: InstanceState,
    expectedRevision: number,
    audit: AuditEntry[],
  ): Promise<boolean> {
    const current = this.instances.get(state.instance.id);
    if (current?.instance.revision !== expectedRevision) return Promise.resolve(false);
    if (this.findActiveConflict(state.instance)) {
      return Promise.reject(new ActiveInstanceExistsError(state.instance.subject));
    }
    this.instances.set(state.instance.id, clone(state));
    this.audit.push(...clone(audit));
    return Promise.resolve(true);
  }

  findInstances(query: InstanceQuery): Promise<Paginated<Instance>> {
    const statuses =
      query.status === undefined
        ? undefined
        : Array.isArray(query.status)
          ? query.status
          : [query.status];
    const matches = [...this.instances.values()]
      .map((state) => state.instance)
      .filter(
        (instance) =>
          (query.subject === undefined ||
            (instance.subject.type === query.subject.type &&
              (query.subject.id === undefined || instance.subject.id === query.subject.id))) &&
          (statuses === undefined || statuses.includes(instance.status)) &&
          (query.flowId === undefined || instance.flowId === query.flowId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    return Promise.resolve(paginate(clone(matches), query));
  }

  findPendingForUser(userId: string, page?: PageQuery): Promise<Paginated<PendingItem>> {
    const items: PendingItem[] = [];
    for (const { instance, steps, approvers } of this.instances.values()) {
      for (const step of steps) {
        if (step.status !== 'active') continue;
        const groupIds = approvers
          .filter((slot) => slot.stepId === step.id && slot.userId === userId)
          .filter((slot) => slot.status === 'pending')
          .map((slot) => slot.groupId);
        if (groupIds.length === 0) continue;
        items.push({
          instance: clone(instance),
          stepId: step.id,
          nodeId: step.nodeId,
          groupIds,
          enteredAt: new Date(step.enteredAt),
          dueAt: step.dueAt && new Date(step.dueAt),
        });
      }
    }
    items.sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime());
    return Promise.resolve(paginate(items, page));
  }

  findTimedOut(now: Date): Promise<InstanceState[]> {
    const due = [...this.instances.values()].filter(({ steps }) =>
      steps.some((step) => step.status === 'active' && step.dueAt !== null && step.dueAt <= now),
    );
    return Promise.resolve(clone(due));
  }

  appendAudit(entries: AuditEntry[]): Promise<void> {
    this.audit.push(...clone(entries));
    return Promise.resolve();
  }

  getAudit(instanceId: string): Promise<AuditEntry[]> {
    return Promise.resolve(clone(this.audit.filter((entry) => entry.instanceId === instanceId)));
  }

  private findActiveConflict(instance: Instance): boolean {
    if (!isActive(instance)) return false;
    for (const other of this.instances.values()) {
      if (
        other.instance.id !== instance.id &&
        isActive(other.instance) &&
        other.instance.subject.type === instance.subject.type &&
        other.instance.subject.id === instance.subject.id
      ) {
        return true;
      }
    }
    return false;
  }
}
