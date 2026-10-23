import { ActiveInstanceExistsError, FlowNotFoundError, FlowVersionExistsError } from '@paraf/core';
import type {
  ApproverSlot,
  AuditEntry,
  FlowSummary,
  FlowVersionMeta,
  Instance,
  InstanceQuery,
  InstanceState,
  PageQuery,
  Paginated,
  ParafStore,
  PendingItem,
  PublishedFlow,
  Step,
} from '@paraf/core';
import type { Pool, PoolClient } from 'pg';
import { errorField } from './driver-errors';
import { assertTablePrefix, migrations, migrationsTable } from './schema';

/** Options of {@link PostgresStore}. */
export interface PostgresStoreOptions {
  /** Prefix of every table and index name. Default `"paraf_"`. */
  tablePrefix?: string;
}

const DEFAULT_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InstanceRow {
  id: string;
  flow_id: string;
  flow_version: number;
  subject_type: string;
  subject_id: string;
  requester_id: string;
  status: Instance['status'];
  current_step_id: string | null;
  round: number;
  document: Instance['document'];
  revision: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface StepRow {
  id: string;
  instance_id: string;
  node_id: string;
  iteration: number;
  chain_level: number;
  round: number;
  status: Step['status'];
  config: Step['config'];
  entered_at: Date;
  due_at: Date | null;
  completed_at: Date | null;
}

interface ApproverRow {
  id: string;
  step_id: string;
  instance_id: string;
  group_id: string;
  user_id: string;
  source: ApproverSlot['source'];
  status: ApproverSlot['status'];
  delegated_from: string | null;
  auto_from_step: string | null;
  decided_at: Date | null;
  comment: string | null;
}

interface AuditRow {
  id: string;
  instance_id: string;
  step_id: string | null;
  node_id: string | null;
  action: AuditEntry['action'];
  actor_id: string | null;
  comment: string | null;
  metadata: AuditEntry['metadata'];
  created_at: Date;
}

const INSTANCE_COLUMNS = [
  'id',
  'flow_id',
  'flow_version',
  'subject_type',
  'subject_id',
  'requester_id',
  'status',
  'current_step_id',
  'round',
  'document',
  'revision',
  'created_at',
  'updated_at',
  'completed_at',
];
const STEP_COLUMNS = [
  'id',
  'instance_id',
  'position',
  'node_id',
  'iteration',
  'chain_level',
  'round',
  'status',
  'config',
  'entered_at',
  'due_at',
  'completed_at',
];
const APPROVER_COLUMNS = [
  'id',
  'step_id',
  'instance_id',
  'position',
  'group_id',
  'user_id',
  'source',
  'status',
  'delegated_from',
  'auto_from_step',
  'decided_at',
  'comment',
];
const AUDIT_COLUMNS = [
  'id',
  'instance_id',
  'step_id',
  'node_id',
  'action',
  'actor_id',
  'comment',
  'metadata',
  'created_at',
];

function toInstance(row: InstanceRow): Instance {
  return {
    id: row.id,
    flowId: row.flow_id,
    flowVersion: row.flow_version,
    subject: { type: row.subject_type, id: row.subject_id },
    requesterId: row.requester_id,
    status: row.status,
    currentStepId: row.current_step_id,
    round: row.round,
    document: row.document,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function toStep(row: StepRow): Step {
  return {
    id: row.id,
    instanceId: row.instance_id,
    nodeId: row.node_id,
    iteration: row.iteration,
    chainLevel: row.chain_level,
    round: row.round,
    status: row.status,
    config: row.config,
    enteredAt: row.entered_at,
    dueAt: row.due_at,
    completedAt: row.completed_at,
  };
}

function toSlot(row: ApproverRow): ApproverSlot {
  return {
    id: row.id,
    stepId: row.step_id,
    instanceId: row.instance_id,
    groupId: row.group_id,
    userId: row.user_id,
    source: row.source,
    status: row.status,
    delegatedFrom: row.delegated_from,
    autoFromStep: row.auto_from_step,
    decidedAt: row.decided_at,
    comment: row.comment,
  };
}

function toAudit(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    instanceId: row.instance_id,
    stepId: row.step_id,
    nodeId: row.node_id,
    action: row.action,
    actorId: row.actor_id,
    comment: row.comment,
    timestamp: row.created_at,
    metadata: row.metadata,
  };
}

function instanceValues(instance: Instance): unknown[] {
  return [
    instance.id,
    instance.flowId,
    instance.flowVersion,
    instance.subject.type,
    instance.subject.id,
    instance.requesterId,
    instance.status,
    instance.currentStepId,
    instance.round,
    JSON.stringify(instance.document),
    instance.revision,
    instance.createdAt,
    instance.updatedAt,
    instance.completedAt,
  ];
}

function stepValues(step: Step, position: number): unknown[] {
  return [
    step.id,
    step.instanceId,
    position,
    step.nodeId,
    step.iteration,
    step.chainLevel,
    step.round,
    step.status,
    JSON.stringify(step.config),
    step.enteredAt,
    step.dueAt,
    step.completedAt,
  ];
}

function slotValues(slot: ApproverSlot, position: number): unknown[] {
  return [
    slot.id,
    slot.stepId,
    slot.instanceId,
    position,
    slot.groupId,
    slot.userId,
    slot.source === null ? null : JSON.stringify(slot.source),
    slot.status,
    slot.delegatedFrom,
    slot.autoFromStep,
    slot.decidedAt,
    slot.comment,
  ];
}

function auditValues(entry: AuditEntry): unknown[] {
  return [
    entry.id,
    entry.instanceId,
    entry.stepId,
    entry.nodeId,
    entry.action,
    entry.actorId,
    entry.comment,
    entry.metadata === null ? null : JSON.stringify(entry.metadata),
    entry.timestamp,
  ];
}

/** `($1, $2), ($3, $4)` placeholders for `rows` rows of `columns` columns. */
function placeholders(rows: number, columns: number, offset = 0): string {
  return Array.from({ length: rows }, (_, row) => {
    const cells = Array.from(
      { length: columns },
      (_, column) => `$${offset + row * columns + column + 1}`,
    );
    return `(${cells.join(', ')})`;
  }).join(', ');
}

/**
 * {@link ParafStore} on PostgreSQL, using a `pg` pool you provide. Run {@link migrate} once
 * (e.g. at startup) or apply `schema.postgres.sql` before use.
 *
 * ```ts
 * const store = new PostgresStore(new Pool({ connectionString }));
 * await store.migrate();
 * const engine = createEngine({ store });
 * ```
 */
export class PostgresStore implements ParafStore {
  private readonly prefix: string;

  constructor(
    private readonly pool: Pool,
    options: PostgresStoreOptions = {},
  ) {
    this.prefix = options.tablePrefix ?? 'paraf_';
    assertTablePrefix(this.prefix);
  }

  /**
   * Creates or upgrades the tables. Safe to call on every startup and from several processes
   * at once: pending migrations run in one transaction under an advisory lock.
   */
  async migrate(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${this.prefix}migrate`]);
      await client.query(migrationsTable(this.prefix));
      const applied = await client.query<{ version: number }>(
        `SELECT version FROM ${this.table('migrations')}`,
      );
      const done = new Set(applied.rows.map((row) => row.version));
      for (const migration of migrations(this.prefix)) {
        if (done.has(migration.version)) continue;
        for (const statement of migration.statements) await client.query(statement);
        await client.query(
          `INSERT INTO ${this.table('migrations')} (version, name) VALUES ($1, $2)`,
          [migration.version, migration.name],
        );
      }
    });
  }

  // ---------------------------------------------------------------------------------------
  // Flows
  // ---------------------------------------------------------------------------------------

  async saveFlowVersion(flow: PublishedFlow, meta: FlowVersionMeta = {}): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO ${this.table('flows')} (flow_id, version, name, definition, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [flow.id, flow.version, flow.name, JSON.stringify(flow), meta.createdBy ?? null],
      );
    } catch (error) {
      if (errorField(error, 'code') === '23505')
        throw new FlowVersionExistsError(flow.id, flow.version);
      throw error;
    }
  }

  async setActiveVersion(flowId: string, version: number): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO ${this.table('flow_heads')} (flow_id, active_version) VALUES ($1, $2)
         ON CONFLICT (flow_id) DO UPDATE
         SET active_version = EXCLUDED.active_version, updated_at = now()`,
        [flowId, version],
      );
    } catch (error) {
      if (errorField(error, 'code') === '23503') throw new FlowNotFoundError(flowId, version);
      throw error;
    }
  }

  async getFlowVersion(flowId: string, version: number): Promise<PublishedFlow | null> {
    const result = await this.pool.query<{ definition: PublishedFlow }>(
      `SELECT definition FROM ${this.table('flows')} WHERE flow_id = $1 AND version = $2`,
      [flowId, version],
    );
    return result.rows[0]?.definition ?? null;
  }

  async getActiveFlow(flowId: string): Promise<PublishedFlow | null> {
    const result = await this.pool.query<{ definition: PublishedFlow }>(
      `SELECT f.definition FROM ${this.table('flow_heads')} h
       JOIN ${this.table('flows')} f ON f.flow_id = h.flow_id AND f.version = h.active_version
       WHERE h.flow_id = $1`,
      [flowId],
    );
    return result.rows[0]?.definition ?? null;
  }

  async listFlows(): Promise<FlowSummary[]> {
    const result = await this.pool.query<{
      flow_id: string;
      name: string;
      version: number;
      active_version: number | null;
    }>(
      `SELECT f.flow_id, f.name, f.version, h.active_version
       FROM ${this.table('flows')} f
       LEFT JOIN ${this.table('flow_heads')} h ON h.flow_id = f.flow_id
       WHERE f.version = (SELECT MAX(version) FROM ${this.table('flows')} m WHERE m.flow_id = f.flow_id)
       ORDER BY f.flow_id`,
    );
    return result.rows.map((row) => ({
      id: row.flow_id,
      name: row.name,
      activeVersion: row.active_version,
      latestVersion: row.version,
    }));
  }

  // ---------------------------------------------------------------------------------------
  // Instances
  // ---------------------------------------------------------------------------------------

  async createInstance(state: InstanceState, audit: AuditEntry[]): Promise<void> {
    await this.transaction(async (client) => {
      await this.insert(client, 'instances', INSTANCE_COLUMNS, [instanceValues(state.instance)]);
      await this.writeChildren(client, state);
      await this.insertAudit(client, audit);
    }, state);
  }

  async getInstance(id: string): Promise<InstanceState | null> {
    if (!UUID.test(id)) return null;
    return this.snapshot(async (client) => {
      const instances = await client.query<InstanceRow>(
        `SELECT * FROM ${this.table('instances')} WHERE id = $1`,
        [id],
      );
      const row = instances.rows[0];
      if (!row) return null;
      const steps = await client.query<StepRow>(
        `SELECT * FROM ${this.table('steps')} WHERE instance_id = $1 ORDER BY position`,
        [id],
      );
      const approvers = await client.query<ApproverRow>(
        `SELECT * FROM ${this.table('approvers')} WHERE instance_id = $1 ORDER BY position`,
        [id],
      );
      return {
        instance: toInstance(row),
        steps: steps.rows.map(toStep),
        approvers: approvers.rows.map(toSlot),
      };
    });
  }

  async updateInstance(
    state: InstanceState,
    expectedRevision: number,
    audit: AuditEntry[],
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const { instance } = state;
      const updated = await client.query(
        `UPDATE ${this.table('instances')}
         SET status = $2, current_step_id = $3, round = $4, document = $5::jsonb, revision = $6,
             updated_at = $7, completed_at = $8
         WHERE id = $1 AND revision = $9`,
        [
          instance.id,
          instance.status,
          instance.currentStepId,
          instance.round,
          JSON.stringify(instance.document),
          instance.revision,
          instance.updatedAt,
          instance.completedAt,
          expectedRevision,
        ],
      );
      if (updated.rowCount !== 1) return false;
      await client.query(
        `DELETE FROM ${this.table('approvers')} WHERE instance_id = $1 AND NOT (id = ANY($2::uuid[]))`,
        [instance.id, state.approvers.map((slot) => slot.id)],
      );
      await this.writeChildren(client, state);
      await this.insertAudit(client, audit);
      return true;
    }, state);
  }

  async findInstances(query: InstanceQuery): Promise<Paginated<Instance>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    };
    if (query.subject) {
      add('subject_type = ?', query.subject.type);
      if (query.subject.id !== undefined) add('subject_id = ?', query.subject.id);
    }
    if (query.status !== undefined) {
      add('status = ANY(?)', Array.isArray(query.status) ? query.status : [query.status]);
    }
    if (query.flowId !== undefined) add('flow_id = ?', query.flowId);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM ${this.table('instances')} ${where}`,
      values,
    );
    const rows = await this.pool.query<InstanceRow>(
      `SELECT * FROM ${this.table('instances')} ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, query.limit ?? DEFAULT_LIMIT, query.offset ?? 0],
    );
    return { items: rows.rows.map(toInstance), total: Number(total.rows[0]?.total) };
  }

  async findPendingForUser(userId: string, page: PageQuery = {}): Promise<Paginated<PendingItem>> {
    const from = `FROM ${this.table('approvers')} a
       JOIN ${this.table('steps')} s ON s.id = a.step_id AND s.status = 'active'
       JOIN ${this.table('instances')} i ON i.id = a.instance_id
       WHERE a.user_id = $1 AND a.status = 'pending'`;
    const total = await this.pool.query<{ total: string }>(
      `SELECT COUNT(DISTINCT a.step_id) AS total ${from}`,
      [userId],
    );
    const rows = await this.pool.query<
      InstanceRow & {
        p_step_id: string;
        p_node_id: string;
        p_entered_at: Date;
        p_due_at: Date | null;
        p_group_ids: string[];
      }
    >(
      `SELECT i.*, s.id AS p_step_id, s.node_id AS p_node_id, s.entered_at AS p_entered_at,
              s.due_at AS p_due_at, array_agg(a.group_id ORDER BY a.position) AS p_group_ids
       ${from}
       GROUP BY i.id, s.id
       ORDER BY s.entered_at, s.id
       LIMIT $2 OFFSET $3`,
      [userId, page.limit ?? DEFAULT_LIMIT, page.offset ?? 0],
    );
    return {
      items: rows.rows.map((row) => ({
        instance: toInstance(row),
        stepId: row.p_step_id,
        nodeId: row.p_node_id,
        groupIds: row.p_group_ids,
        enteredAt: row.p_entered_at,
        dueAt: row.p_due_at,
      })),
      total: Number(total.rows[0]?.total),
    };
  }

  async findTimedOut(now: Date): Promise<InstanceState[]> {
    const due = await this.pool.query<{ instance_id: string }>(
      `SELECT DISTINCT instance_id FROM ${this.table('steps')}
       WHERE status = 'active' AND due_at <= $1 ORDER BY instance_id`,
      [now],
    );
    const states = await Promise.all(due.rows.map((row) => this.getInstance(row.instance_id)));
    return states.filter((state): state is InstanceState => state !== null);
  }

  // ---------------------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------------------

  async appendAudit(entries: AuditEntry[]): Promise<void> {
    await this.insertAudit(this.pool, entries);
  }

  async getAudit(instanceId: string): Promise<AuditEntry[]> {
    if (!UUID.test(instanceId)) return [];
    const result = await this.pool.query<AuditRow>(
      `SELECT * FROM ${this.table('audit')} WHERE instance_id = $1 ORDER BY seq`,
      [instanceId],
    );
    return result.rows.map(toAudit);
  }

  // ---------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------

  private table(name: string): string {
    return `${this.prefix}${name}`;
  }

  /** Inserts new steps and slots and updates existing ones. */
  private async writeChildren(client: PoolClient, state: InstanceState): Promise<void> {
    await this.upsert(
      client,
      'steps',
      STEP_COLUMNS,
      state.steps.map((step, position) => stepValues(step, position)),
      ['position', 'status', 'config', 'due_at', 'completed_at'],
    );
    await this.upsert(
      client,
      'approvers',
      APPROVER_COLUMNS,
      state.approvers.map((slot, position) => slotValues(slot, position)),
      ['position', 'status', 'delegated_from', 'auto_from_step', 'decided_at', 'comment', 'source'],
    );
  }

  private async insertAudit(client: Pool | PoolClient, entries: AuditEntry[]): Promise<void> {
    await this.insert(client, 'audit', AUDIT_COLUMNS, entries.map(auditValues));
  }

  private async insert(
    client: Pool | PoolClient,
    table: string,
    columns: string[],
    rows: unknown[][],
  ): Promise<void> {
    if (rows.length === 0) return;
    await client.query(
      `INSERT INTO ${this.table(table)} (${columns.join(', ')})
       VALUES ${placeholders(rows.length, columns.length)}`,
      rows.flat(),
    );
  }

  private async upsert(
    client: PoolClient,
    table: string,
    columns: string[],
    rows: unknown[][],
    updatable: string[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await client.query(
      `INSERT INTO ${this.table(table)} (${columns.join(', ')})
       VALUES ${placeholders(rows.length, columns.length)}
       ON CONFLICT (id) DO UPDATE SET ${updatable.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
      rows.flat(),
    );
  }

  /** Runs `work` in a transaction; maps the one-active-instance constraint to its error. */
  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
    state?: InstanceState,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query(result === false ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (state && errorField(error, 'constraint') === `uq_${this.prefix}inst_active_subject`) {
        throw new ActiveInstanceExistsError(state.instance.subject);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Runs read-only queries against one consistent snapshot. */
  private async snapshot<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
