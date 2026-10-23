/** One schema change, applied once and recorded in the migrations table. */
export interface Migration {
  version: number;
  name: string;
  /**
   * DDL statements. MySQL commits DDL implicitly, so each statement is idempotent: a migration
   * that failed halfway can simply run again.
   */
  statements: string[];
}

/** Table prefixes are interpolated into SQL, so they are restricted to safe identifiers. */
export const TABLE_PREFIX_PATTERN = /^[a-z_][a-z0-9_]{0,30}$/;

/** Throws when `prefix` could not be used safely in table names. */
export function assertTablePrefix(prefix: string): void {
  if (!TABLE_PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(
      `Paraf: invalid table prefix "${prefix}"; use lowercase letters, digits, and "_" (max 31).`,
    );
  }
}

const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';

/** The table that records applied migrations. */
export function migrationsTable(p: string): string {
  return `CREATE TABLE IF NOT EXISTS ${p}migrations (
  version     INT          NOT NULL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  applied_at  DATETIME(3)  NOT NULL DEFAULT (UTC_TIMESTAMP(3))
) ${TABLE_OPTIONS}`;
}

/** All migrations, oldest first. `p` is the table prefix. */
export function migrations(p: string): Migration[] {
  return [
    {
      version: 1,
      name: 'initial schema',
      statements: [
        `CREATE TABLE IF NOT EXISTS ${p}flows (
  flow_id      VARCHAR(100) NOT NULL,
  version      INT          NOT NULL,
  name         VARCHAR(255) NOT NULL,
  definition   JSON         NOT NULL,
  created_by   VARCHAR(255),
  created_at   DATETIME(3)  NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (flow_id, version)
) ${TABLE_OPTIONS}`,
        `CREATE TABLE IF NOT EXISTS ${p}flow_heads (
  flow_id         VARCHAR(100) NOT NULL PRIMARY KEY,
  active_version  INT          NOT NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  FOREIGN KEY (flow_id, active_version) REFERENCES ${p}flows (flow_id, version)
) ${TABLE_OPTIONS}`,
        `CREATE TABLE IF NOT EXISTS ${p}instances (
  id                  BINARY(16)   NOT NULL PRIMARY KEY,
  flow_id             VARCHAR(100) NOT NULL,
  flow_version        INT          NOT NULL,
  subject_type        VARCHAR(100) NOT NULL,
  subject_id          VARCHAR(255) NOT NULL,
  requester_id        VARCHAR(255) NOT NULL,
  status              VARCHAR(20)  NOT NULL,
  current_step_id     BINARY(16),
  round               INT          NOT NULL DEFAULT 1,
  document            JSON         NOT NULL,
  revision            INT          NOT NULL DEFAULT 0,
  created_at          DATETIME(3)  NOT NULL,
  updated_at          DATETIME(3)  NOT NULL,
  completed_at        DATETIME(3),
  active_subject_key  VARCHAR(360),
  UNIQUE KEY uq_${p}inst_active_subject (active_subject_key),
  KEY idx_${p}inst_subject (subject_type, subject_id),
  KEY idx_${p}inst_status (status),
  FOREIGN KEY (flow_id, flow_version) REFERENCES ${p}flows (flow_id, version)
) ${TABLE_OPTIONS}`,
        `CREATE TABLE IF NOT EXISTS ${p}steps (
  id            BINARY(16)   NOT NULL PRIMARY KEY,
  instance_id   BINARY(16)   NOT NULL,
  position      INT          NOT NULL,
  node_id       VARCHAR(100) NOT NULL,
  iteration     INT          NOT NULL,
  chain_level   INT          NOT NULL DEFAULT 0,
  round         INT          NOT NULL,
  status        VARCHAR(20)  NOT NULL,
  config        JSON         NOT NULL,
  entered_at    DATETIME(3)  NOT NULL,
  due_at        DATETIME(3),
  completed_at  DATETIME(3),
  UNIQUE KEY (instance_id, node_id, iteration, chain_level),
  KEY idx_${p}steps_due (status, due_at),
  FOREIGN KEY (instance_id) REFERENCES ${p}instances (id)
) ${TABLE_OPTIONS}`,
        `CREATE TABLE IF NOT EXISTS ${p}approvers (
  id              BINARY(16)   NOT NULL PRIMARY KEY,
  step_id         BINARY(16)   NOT NULL,
  instance_id     BINARY(16)   NOT NULL,
  position        INT          NOT NULL,
  group_id        VARCHAR(100) NOT NULL DEFAULT 'default',
  user_id         VARCHAR(255) NOT NULL,
  source          JSON,
  status          VARCHAR(20)  NOT NULL,
  delegated_from  VARCHAR(255),
  auto_from_step  BINARY(16),
  decided_at      DATETIME(3),
  comment         TEXT,
  UNIQUE KEY (step_id, group_id, user_id),
  KEY idx_${p}appr_user_pending (user_id, status),
  KEY idx_${p}appr_instance (instance_id),
  FOREIGN KEY (step_id) REFERENCES ${p}steps (id)
) ${TABLE_OPTIONS}`,
        `CREATE TABLE IF NOT EXISTS ${p}audit (
  seq          BIGINT       NOT NULL AUTO_INCREMENT,
  id           BINARY(16)   NOT NULL PRIMARY KEY,
  instance_id  BINARY(16)   NOT NULL,
  step_id      BINARY(16),
  node_id      VARCHAR(100),
  action       VARCHAR(50)  NOT NULL,
  actor_id     VARCHAR(255),
  comment      TEXT,
  metadata     JSON,
  created_at   DATETIME(3)  NOT NULL,
  UNIQUE KEY (seq),
  KEY idx_${p}audit_instance (instance_id, seq),
  FOREIGN KEY (instance_id) REFERENCES ${p}instances (id)
) ${TABLE_OPTIONS}`,
      ],
    },
  ];
}

/** The whole schema as one SQL script (what `migrate()` creates), for manual setup. */
export function schemaSql(p = 'paraf_'): string {
  assertTablePrefix(p);
  const parts = [
    '-- Paraf schema for MySQL 8 (InnoDB). Generated by `pnpm --filter @paraf/mysql schema`;',
    '-- do not edit by hand. Equivalent to `MySqlStore#migrate()` with the default prefix.',
    '-- IDs are BINARY(16) UUIDs and times are DATETIME(3) in UTC.',
    '',
    `${migrationsTable(p)};`,
  ];
  for (const migration of migrations(p)) {
    parts.push('', `-- ${migration.version}: ${migration.name}`);
    for (const statement of migration.statements) parts.push(`${statement};`);
    parts.push(
      `INSERT IGNORE INTO ${p}migrations (version, name) VALUES (${migration.version}, '${migration.name}');`,
    );
  }
  return `${parts.join('\n')}\n`;
}
