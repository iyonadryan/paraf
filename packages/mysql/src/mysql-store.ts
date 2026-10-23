import {
  ACTIVE_INSTANCE_STATUSES,
  ActiveInstanceExistsError,
  FlowNotFoundError,
  FlowVersionExistsError,
} from '@paraf/core';
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
import type { Pool, PoolConnection, QueryOptions, ResultSetHeader } from 'mysql2/promise';
import { errorMessage, errorNumber } from './driver-errors';
import { assertTablePrefix, migrations, migrationsTable } from './schema';

/** Options of {@link MySqlStore}. */
export interface MySqlStoreOptions {
  /** Prefix of every table and index name. Default `"paraf_"`. */
  tablePrefix?: string;
}

const DEFAULT_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Queryable = Pool | PoolConnection;

// ---------------------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------------------

/** UUID string → BINARY(16). The MySQL store needs UUIDs (the engine's default IDs). */
function toBinary(id: string): Buffer {
  if (!UUID.test(id)) throw new TypeError(`Paraf: MySqlStore needs UUID ids, got "${id}".`);
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}

function toBinaryOrNull(id: string | null): Buffer | null {
  return id === null ? null : toBinary(id);
}

/** BINARY(16) → lowercase UUID string. */
function fromBinary(value: Buffer): string {
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fromBinaryOrNull(value: Buffer | null): string | null {
  return value === null ? null : fromBinary(value);
}

/** Date → `YYYY-MM-DD HH:MM:SS.mmm` in UTC, independent of the connection's time zone. */
function toDatetime(date: Date): string {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function toDatetimeOrNull(date: Date | null): string | null {
  return date === null ? null : toDatetime(date);
}

function fromDatetime(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

function fromDatetimeOrNull(value: string | null): Date | null {
  return value === null ? null : fromDatetime(value);
}

/** JSON columns arrive parsed, or as text when the pool uses `jsonStrings`. */
function fromJson(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
}

function json(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

/** Unique while the instance is active, `NULL` afterwards (MySQL allows many NULLs). */
function activeSubjectKey(instance: Instance): string | null {
  if (!ACTIVE_INSTANCE_STATUSES.includes(instance.status)) return null;
  const { type, id } = instance.subject;
  return `${type.length}:${type}:${id}`;
}

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

interface InstanceRow {
  id: Buffer;
  flow_id: string;
  flow_version: number;
  subject_type: string;
  subject_id: string;
  requester_id: string;
  status: Instance['status'];
  current_step_id: Buffer | null;
  round: number;
  document: unknown;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface StepRow {
  id: Buffer;
  instance_id: Buffer;
  node_id: string;
  iteration: number;
  chain_level: number;
  round: number;
  status: Step['status'];
  config: unknown;
  entered_at: string;
  due_at: string | null;
  completed_at: string | null;
}

interface ApproverRow {
  id: Buffer;
  step_id: Buffer;
  instance_id: Buffer;
  group_id: string;
  user_id: string;
  source: unknown;
  status: ApproverSlot['status'];
  delegated_from: string | null;
  auto_from_step: Buffer | null;
  decided_at: string | null;
  comment: string | null;
}

interface AuditRow {
  id: Buffer;
  instance_id: Buffer;
  step_id: Buffer | null;
  node_id: string | null;
  action: AuditEntry['action'];
  actor_id: string | null;
  comment: string | null;
  metadata: unknown;
  created_at: string;
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
  'active_subject_key',
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
    id: fromBinary(row.id),
    flowId: row.flow_id,
    flowVersion: row.flow_version,
    subject: { type: row.subject_type, id: row.subject_id },
    requesterId: row.requester_id,
    status: row.status,
    currentStepId: fromBinaryOrNull(row.current_step_id),
    round: row.round,
    document: fromJson(row.document) as Instance['document'],
    revision: row.revision,
    createdAt: fromDatetime(row.created_at),
    updatedAt: fromDatetime(row.updated_at),
    completedAt: fromDatetimeOrNull(row.completed_at),
  };
}

function toStep(row: StepRow): Step {
  return {
    id: fromBinary(row.id),
    instanceId: fromBinary(row.instance_id),
    nodeId: row.node_id,
    iteration: row.iteration,
    chainLevel: row.chain_level,
    round: row.round,
    status: row.status,
    config: fromJson(row.config) as Step['config'],
    enteredAt: fromDatetime(row.entered_at),
    dueAt: fromDatetimeOrNull(row.due_at),
    completedAt: fromDatetimeOrNull(row.completed_at),
  };
}

function toSlot(row: ApproverRow): ApproverSlot {
  return {
    id: fromBinary(row.id),
    stepId: fromBinary(row.step_id),
    instanceId: fromBinary(row.instance_id),
    groupId: row.group_id,
    userId: row.user_id,
    source: fromJson(row.source) as ApproverSlot['source'],
    status: row.status,
    delegatedFrom: row.delegated_from,
    autoFromStep: fromBinaryOrNull(row.auto_from_step),
    decidedAt: fromDatetimeOrNull(row.decided_at),
    comment: row.comment,
  };
}

function toAudit(row: AuditRow): AuditEntry {
  return {
    id: fromBinary(row.id),
    instanceId: fromBinary(row.instance_id),
    stepId: fromBinaryOrNull(row.step_id),
    nodeId: row.node_id,
    action: row.action,
    actorId: row.actor_id,
    comment: row.comment,
    timestamp: fromDatetime(row.created_at),
    metadata: fromJson(row.metadata) as AuditEntry['metadata'],
  };
}

function instanceValues(instance: Instance): unknown[] {
  return [
    toBinary(instance.id),
    instance.flowId,
    instance.flowVersion,
    instance.subject.type,
    instance.subject.id,
    instance.requesterId,
    instance.status,
    toBinaryOrNull(instance.currentStepId),
    instance.round,
    json(instance.document),
    instance.revision,
    toDatetime(instance.createdAt),
    toDatetime(instance.updatedAt),
    toDatetimeOrNull(instance.completedAt),
    activeSubjectKey(instance),
  ];
}

function stepValues(step: Step, position: number): unknown[] {
  return [
    toBinary(step.id),
    toBinary(step.instanceId),
    position,
    step.nodeId,
    step.iteration,
    step.chainLevel,
    step.round,
    step.status,
    json(step.config),
    toDatetime(step.enteredAt),
    toDatetimeOrNull(step.dueAt),
    toDatetimeOrNull(step.completedAt),
  ];
}

function slotValues(slot: ApproverSlot, position: number): unknown[] {
  return [
    toBinary(slot.id),
    toBinary(slot.stepId),
    toBinary(slot.instanceId),
    position,
    slot.groupId,
    slot.userId,
    json(slot.source),
    slot.status,
    slot.delegatedFrom,
    toBinaryOrNull(slot.autoFromStep),
    toDatetimeOrNull(slot.decidedAt),
    slot.comment,
  ];
}

function auditValues(entry: AuditEntry): unknown[] {
  return [
    toBinary(entry.id),
    toBinary(entry.instanceId),
    toBinaryOrNull(entry.stepId),
    entry.nodeId,
    entry.action,
    entry.actorId,
    entry.comment,
    json(entry.metadata),
    toDatetime(entry.timestamp),
  ];
}

/** Reads DATETIME columns as text so values are never shifted by the pool's time zone. */
const typeCast: QueryOptions['typeCast'] = (field, next) =>
  field.type === 'DATETIME' ? field.string() : next();

/**
 * {@link ParafStore} on MySQL 8 (InnoDB), using a `mysql2/promise` pool you provide. Run
 * {@link migrate} once (e.g. at startup) or apply `schema.mysql.sql` before use. IDs are stored
 * as `BINARY(16)`, so the engine must use UUIDs (its default).
 *
 * ```ts
 * const store = new MySqlStore(mysql.createPool(url));
 * await store.migrate();
 * const engine = createEngine({ store });
 * ```
 */
export class MySqlStore implements ParafStore {
  private readonly prefix: string;

  constructor(
    private readonly pool: Pool,
    options: MySqlStoreOptions = {},
  ) {
    this.prefix = options.tablePrefix ?? 'paraf_';
    assertTablePrefix(this.prefix);
  }

  /**
   * Creates or upgrades the tables. Safe to call on every startup and from several processes
   * at once (a named lock serializes them). MySQL commits DDL immediately, so each migration's
   * statements are idempotent and a failed migration can be retried.
   */
  async migrate(): Promise<void> {
    const connection = await this.pool.getConnection();
    const lock = `${this.prefix}migrate`;
    try {
      await connection.query('SELECT GET_LOCK(?, 60)', [lock]);
      await connection.query(migrationsTable(this.prefix));
      const [rows] = await connection.query(`SELECT version FROM ${this.table('migrations')}`);
      const done = new Set((rows as { version: number }[]).map((row) => row.version));
      for (const migration of migrations(this.prefix)) {
        if (done.has(migration.version)) continue;
        for (const statement of migration.statements) await connection.query(statement);
        await connection.query(
          `INSERT INTO ${this.table('migrations')} (version, name) VALUES (?, ?)`,
          [migration.version, migration.name],
        );
      }
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [lock]);
      connection.release();
    }
  }

  // ---------------------------------------------------------------------------------------
  // Flows
  // ---------------------------------------------------------------------------------------

  async saveFlowVersion(flow: PublishedFlow, meta: FlowVersionMeta = {}): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO ${this.table('flows')} (flow_id, version, name, definition, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [flow.id, flow.version, flow.name, JSON.stringify(flow), meta.createdBy ?? null],
      );
    } catch (error) {
      if (errorNumber(error) === 1062) throw new FlowVersionExistsError(flow.id, flow.version);
      throw error;
    }
  }

  async setActiveVersion(flowId: string, version: number): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO ${this.table('flow_heads')} (flow_id, active_version, updated_at)
         VALUES (?, ?, UTC_TIMESTAMP(3)) AS new
         ON DUPLICATE KEY UPDATE active_version = new.active_version, updated_at = new.updated_at`,
        [flowId, version],
      );
    } catch (error) {
      if (errorNumber(error) === 1452) throw new FlowNotFoundError(flowId, version);
      throw error;
    }
  }

  async getFlowVersion(flowId: string, version: number): Promise<PublishedFlow | null> {
    const rows = await this.select<{ definition: unknown }>(
      this.pool,
      `SELECT definition FROM ${this.table('flows')} WHERE flow_id = ? AND version = ?`,
      [flowId, version],
    );
    return rows[0] ? (fromJson(rows[0].definition) as PublishedFlow) : null;
  }

  async getActiveFlow(flowId: string): Promise<PublishedFlow | null> {
    const rows = await this.select<{ definition: unknown }>(
      this.pool,
      `SELECT f.definition FROM ${this.table('flow_heads')} h
       JOIN ${this.table('flows')} f ON f.flow_id = h.flow_id AND f.version = h.active_version
       WHERE h.flow_id = ?`,
      [flowId],
    );
    return rows[0] ? (fromJson(rows[0].definition) as PublishedFlow) : null;
  }

  async listFlows(): Promise<FlowSummary[]> {
    const rows = await this.select<{
      flow_id: string;
      name: string;
      version: number;
      active_version: number | null;
    }>(
      this.pool,
      `SELECT f.flow_id, f.name, f.version, h.active_version
       FROM ${this.table('flows')} f
       LEFT JOIN ${this.table('flow_heads')} h ON h.flow_id = f.flow_id
       WHERE f.version = (SELECT MAX(version) FROM ${this.table('flows')} m WHERE m.flow_id = f.flow_id)
       ORDER BY f.flow_id`,
    );
    return rows.map((row) => ({
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
    await this.transaction(async (connection) => {
      await this.insert(connection, 'instances', INSTANCE_COLUMNS, [
        instanceValues(state.instance),
      ]);
      await this.writeChildren(connection, state);
      await this.insert(connection, 'audit', AUDIT_COLUMNS, audit.map(auditValues));
    }, state);
  }

  async getInstance(id: string): Promise<InstanceState | null> {
    if (!UUID.test(id)) return null;
    return this.snapshot(async (connection) => {
      const key = toBinary(id);
      const [row] = await this.select<InstanceRow>(
        connection,
        `SELECT * FROM ${this.table('instances')} WHERE id = ?`,
        [key],
      );
      if (!row) return null;
      const steps = await this.select<StepRow>(
        connection,
        `SELECT * FROM ${this.table('steps')} WHERE instance_id = ? ORDER BY position`,
        [key],
      );
      const approvers = await this.select<ApproverRow>(
        connection,
        `SELECT * FROM ${this.table('approvers')} WHERE instance_id = ? ORDER BY position`,
        [key],
      );
      return {
        instance: toInstance(row),
        steps: steps.map(toStep),
        approvers: approvers.map(toSlot),
      };
    });
  }

  async updateInstance(
    state: InstanceState,
    expectedRevision: number,
    audit: AuditEntry[],
  ): Promise<boolean> {
    return this.transaction(async (connection) => {
      const { instance } = state;
      const key = toBinary(instance.id);
      const [result] = await connection.query<ResultSetHeader>(
        `UPDATE ${this.table('instances')}
         SET status = ?, current_step_id = ?, round = ?, document = ?, revision = ?,
             updated_at = ?, completed_at = ?, active_subject_key = ?
         WHERE id = ? AND revision = ?`,
        [
          instance.status,
          toBinaryOrNull(instance.currentStepId),
          instance.round,
          json(instance.document),
          instance.revision,
          toDatetime(instance.updatedAt),
          toDatetimeOrNull(instance.completedAt),
          activeSubjectKey(instance),
          key,
          expectedRevision,
        ],
      );
      if (result.affectedRows !== 1) return false;
      const keep = state.approvers.map((slot) => toBinary(slot.id));
      await connection.query(
        `DELETE FROM ${this.table('approvers')} WHERE instance_id = ?${keep.length > 0 ? ' AND id NOT IN (?)' : ''}`,
        keep.length > 0 ? [key, keep] : [key],
      );
      await this.writeChildren(connection, state);
      await this.insert(connection, 'audit', AUDIT_COLUMNS, audit.map(auditValues));
      return true;
    }, state);
  }

  async findInstances(query: InstanceQuery): Promise<Paginated<Instance>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.subject) {
      conditions.push('subject_type = ?');
      values.push(query.subject.type);
      if (query.subject.id !== undefined) {
        conditions.push('subject_id = ?');
        values.push(query.subject.id);
      }
    }
    if (query.status !== undefined) {
      conditions.push('status IN (?)');
      values.push(Array.isArray(query.status) ? query.status : [query.status]);
    }
    if (query.flowId !== undefined) {
      conditions.push('flow_id = ?');
      values.push(query.flowId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [count] = await this.select<{ total: number }>(
      this.pool,
      `SELECT COUNT(*) AS total FROM ${this.table('instances')} ${where}`,
      values,
    );
    const rows = await this.select<InstanceRow>(
      this.pool,
      `SELECT * FROM ${this.table('instances')} ${where}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...values, query.limit ?? DEFAULT_LIMIT, query.offset ?? 0],
    );
    return { items: rows.map(toInstance), total: Number(count?.total) };
  }

  async findPendingForUser(userId: string, page: PageQuery = {}): Promise<Paginated<PendingItem>> {
    const from = `FROM ${this.table('approvers')} a
       JOIN ${this.table('steps')} s ON s.id = a.step_id AND s.status = 'active'
       JOIN ${this.table('instances')} i ON i.id = a.instance_id
       WHERE a.user_id = ? AND a.status = 'pending'`;
    const [count] = await this.select<{ total: number }>(
      this.pool,
      `SELECT COUNT(DISTINCT a.step_id) AS total ${from}`,
      [userId],
    );
    const rows = await this.select<
      InstanceRow & {
        p_step_id: Buffer;
        p_node_id: string;
        p_entered_at: string;
        p_due_at: string | null;
        p_group_ids: string;
      }
    >(
      this.pool,
      `SELECT i.*, s.id AS p_step_id, s.node_id AS p_node_id, s.entered_at AS p_entered_at,
              s.due_at AS p_due_at,
              GROUP_CONCAT(a.group_id ORDER BY a.position SEPARATOR ',') AS p_group_ids
       ${from}
       GROUP BY i.id, s.id
       ORDER BY s.entered_at, s.id
       LIMIT ? OFFSET ?`,
      [userId, page.limit ?? DEFAULT_LIMIT, page.offset ?? 0],
    );
    return {
      items: rows.map((row) => ({
        instance: toInstance(row),
        stepId: fromBinary(row.p_step_id),
        nodeId: row.p_node_id,
        groupIds: row.p_group_ids.split(','),
        enteredAt: fromDatetime(row.p_entered_at),
        dueAt: fromDatetimeOrNull(row.p_due_at),
      })),
      total: Number(count?.total),
    };
  }

  async findTimedOut(now: Date): Promise<InstanceState[]> {
    const rows = await this.select<{ instance_id: Buffer }>(
      this.pool,
      `SELECT DISTINCT instance_id FROM ${this.table('steps')}
       WHERE status = 'active' AND due_at <= ? ORDER BY instance_id`,
      [toDatetime(now)],
    );
    const states = await Promise.all(
      rows.map((row) => this.getInstance(fromBinary(row.instance_id))),
    );
    return states.filter((state): state is InstanceState => state !== null);
  }

  // ---------------------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------------------

  async appendAudit(entries: AuditEntry[]): Promise<void> {
    await this.insert(this.pool, 'audit', AUDIT_COLUMNS, entries.map(auditValues));
  }

  async getAudit(instanceId: string): Promise<AuditEntry[]> {
    if (!UUID.test(instanceId)) return [];
    const rows = await this.select<AuditRow>(
      this.pool,
      `SELECT * FROM ${this.table('audit')} WHERE instance_id = ? ORDER BY seq`,
      [toBinary(instanceId)],
    );
    return rows.map(toAudit);
  }

  // ---------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------

  private table(name: string): string {
    return `${this.prefix}${name}`;
  }

  private async select<T>(client: Queryable, sql: string, values: unknown[] = []): Promise<T[]> {
    const [rows] = await client.query({ sql, values, typeCast });
    return rows as T[];
  }

  /** Inserts new steps and slots and updates existing ones. */
  private async writeChildren(connection: PoolConnection, state: InstanceState): Promise<void> {
    await this.upsert(
      connection,
      'steps',
      STEP_COLUMNS,
      state.steps.map((step, position) => stepValues(step, position)),
      ['position', 'status', 'config', 'due_at', 'completed_at'],
    );
    await this.upsert(
      connection,
      'approvers',
      APPROVER_COLUMNS,
      state.approvers.map((slot, position) => slotValues(slot, position)),
      ['position', 'status', 'delegated_from', 'auto_from_step', 'decided_at', 'comment', 'source'],
    );
  }

  private async insert(
    client: Queryable,
    table: string,
    columns: string[],
    rows: unknown[][],
  ): Promise<void> {
    if (rows.length === 0) return;
    await client.query(`INSERT INTO ${this.table(table)} (${columns.join(', ')}) VALUES ?`, [rows]);
  }

  private async upsert(
    connection: PoolConnection,
    table: string,
    columns: string[],
    rows: unknown[][],
    updatable: string[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await connection.query(
      `INSERT INTO ${this.table(table)} (${columns.join(', ')}) VALUES ? AS new
       ON DUPLICATE KEY UPDATE ${updatable.map((c) => `${c} = new.${c}`).join(', ')}`,
      [rows],
    );
  }

  /** Runs `work` in a transaction; maps the one-active-instance constraint to its error. */
  private async transaction<T>(
    work: (connection: PoolConnection) => Promise<T>,
    state: InstanceState,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      if (result === false) await connection.rollback();
      else await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      if (
        errorNumber(error) === 1062 &&
        errorMessage(error).includes(`uq_${this.prefix}inst_active_subject`)
      ) {
        throw new ActiveInstanceExistsError(state.instance.subject);
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  /** Runs read-only queries against one consistent snapshot. */
  private async snapshot<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
