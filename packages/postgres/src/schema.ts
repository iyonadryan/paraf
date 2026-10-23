/** One schema change, applied once and recorded in the migrations table. */
export interface Migration {
  version: number;
  name: string;
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

/** The table that records applied migrations. */
export function migrationsTable(p: string): string {
  return `CREATE TABLE IF NOT EXISTS ${p}migrations (
  version     INT          PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  applied_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
)`;
}

/** All migrations, oldest first. `p` is the table prefix. */
export function migrations(p: string): Migration[] {
  return [
    {
      version: 1,
      name: 'initial schema',
      statements: [
        `CREATE TABLE ${p}flows (
  flow_id      VARCHAR(100) NOT NULL,
  version      INT          NOT NULL,
  name         VARCHAR(255) NOT NULL,
  definition   JSONB        NOT NULL,
  created_by   VARCHAR(255),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, version)
)`,
        `CREATE TABLE ${p}flow_heads (
  flow_id         VARCHAR(100) PRIMARY KEY,
  active_version  INT          NOT NULL,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  FOREIGN KEY (flow_id, active_version) REFERENCES ${p}flows (flow_id, version)
)`,
        `CREATE TABLE ${p}instances (
  id               UUID         PRIMARY KEY,
  flow_id          VARCHAR(100) NOT NULL,
  flow_version     INT          NOT NULL,
  subject_type     VARCHAR(100) NOT NULL,
  subject_id       VARCHAR(255) NOT NULL,
  requester_id     VARCHAR(255) NOT NULL,
  status           VARCHAR(20)  NOT NULL,
  current_step_id  UUID,
  round            INT          NOT NULL DEFAULT 1,
  document         JSONB        NOT NULL,
  revision         INT          NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  FOREIGN KEY (flow_id, flow_version) REFERENCES ${p}flows (flow_id, version)
)`,
        `CREATE INDEX idx_${p}inst_subject ON ${p}instances (subject_type, subject_id)`,
        `CREATE INDEX idx_${p}inst_status ON ${p}instances (status)`,
        `CREATE UNIQUE INDEX uq_${p}inst_active_subject
  ON ${p}instances (subject_type, subject_id)
  WHERE status IN ('pending', 'in_progress', 'returned')`,
        `CREATE TABLE ${p}steps (
  id            UUID         PRIMARY KEY,
  instance_id   UUID         NOT NULL REFERENCES ${p}instances (id),
  position      INT          NOT NULL,
  node_id       VARCHAR(100) NOT NULL,
  iteration     INT          NOT NULL,
  chain_level   INT          NOT NULL DEFAULT 0,
  round         INT          NOT NULL,
  status        VARCHAR(20)  NOT NULL,
  config        JSONB        NOT NULL,
  entered_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  due_at        TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  UNIQUE (instance_id, node_id, iteration, chain_level)
)`,
        `CREATE INDEX idx_${p}steps_instance ON ${p}steps (instance_id)`,
        `CREATE INDEX idx_${p}steps_due ON ${p}steps (status, due_at)`,
        `CREATE TABLE ${p}approvers (
  id              UUID         PRIMARY KEY,
  step_id         UUID         NOT NULL REFERENCES ${p}steps (id),
  instance_id     UUID         NOT NULL,
  position        INT          NOT NULL,
  group_id        VARCHAR(100) NOT NULL DEFAULT 'default',
  user_id         VARCHAR(255) NOT NULL,
  source          JSONB,
  status          VARCHAR(20)  NOT NULL,
  delegated_from  VARCHAR(255),
  auto_from_step  UUID,
  decided_at      TIMESTAMPTZ,
  comment         TEXT,
  UNIQUE (step_id, group_id, user_id)
)`,
        `CREATE INDEX idx_${p}appr_user_pending ON ${p}approvers (user_id, status)`,
        `CREATE INDEX idx_${p}appr_step ON ${p}approvers (step_id)`,
        `CREATE INDEX idx_${p}appr_instance ON ${p}approvers (instance_id)`,
        `CREATE TABLE ${p}audit (
  seq          BIGINT       GENERATED ALWAYS AS IDENTITY,
  id           UUID         PRIMARY KEY,
  instance_id  UUID         NOT NULL REFERENCES ${p}instances (id),
  step_id      UUID,
  node_id      VARCHAR(100),
  action       VARCHAR(50)  NOT NULL,
  actor_id     VARCHAR(255),
  comment      TEXT,
  metadata     JSONB,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
)`,
        `CREATE INDEX idx_${p}audit_instance ON ${p}audit (instance_id, seq)`,
      ],
    },
  ];
}

/** The whole schema as one SQL script (what `migrate()` creates), for manual setup. */
export function schemaSql(p = 'paraf_'): string {
  assertTablePrefix(p);
  const parts = [
    '-- Paraf schema for PostgreSQL. Generated by `pnpm --filter @paraf/postgres schema`;',
    '-- do not edit by hand. Equivalent to `PostgresStore#migrate()` with the default prefix.',
    '',
    `${migrationsTable(p)};`,
  ];
  for (const migration of migrations(p)) {
    parts.push('', `-- ${migration.version}: ${migration.name}`);
    for (const statement of migration.statements) parts.push(`${statement};`);
    parts.push(
      `INSERT INTO ${p}migrations (version, name) VALUES (${migration.version}, '${migration.name}');`,
    );
  }
  return `${parts.join('\n')}\n`;
}
