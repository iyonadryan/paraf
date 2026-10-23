import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/schema';
import { createPool, dropTables, PostgresStore } from './db';
import { flowVersion, instanceState } from '@paraf/store-tests';

const pool = createPool();
const prefix = 'paraf_migrate_';

afterAll(async () => {
  await pool.end();
});

async function tables(name: string): Promise<string[]> {
  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE $1 ORDER BY 1`,
    [`${name.replace(/_/g, '\\_')}%`],
  );
  return result.rows.map((row) => row.tablename);
}

describe('PostgresStore migrations', () => {
  beforeEach(async () => {
    await dropTables(pool, prefix);
  });
  afterAll(async () => {
    await dropTables(pool, prefix);
  });

  it('creates the tables with the configured prefix and records the version', async () => {
    await new PostgresStore(pool, { tablePrefix: prefix }).migrate();
    expect(await tables(prefix)).toEqual(
      ['approvers', 'audit', 'flow_heads', 'flows', 'instances', 'migrations', 'steps'].map(
        (table) => prefix + table,
      ),
    );
    const applied = await pool.query(`SELECT version, name FROM ${prefix}migrations`);
    expect(applied.rows).toEqual([{ version: 1, name: 'initial schema' }]);
  });

  it('is idempotent and safe to run concurrently', async () => {
    const store = new PostgresStore(pool, { tablePrefix: prefix });
    await Promise.all([store.migrate(), store.migrate(), store.migrate()]);
    await store.migrate();
    const applied = await pool.query(`SELECT COUNT(*)::int AS n FROM ${prefix}migrations`);
    expect(applied.rows[0]).toEqual({ n: 1 });
  });

  it('rolls back a failed migration', async () => {
    await pool.query(`CREATE TABLE ${prefix}steps (id INT)`); // clashes with the migration
    await expect(new PostgresStore(pool, { tablePrefix: prefix }).migrate()).rejects.toThrow(
      /already exists/,
    );
    expect(await tables(prefix)).toEqual([`${prefix}steps`]);
  });

  it('uses the paraf_ prefix by default', async () => {
    const names = ['audit', 'approvers', 'steps', 'instances', 'flow_heads', 'flows', 'migrations'];
    const drop = () =>
      pool.query(`DROP TABLE IF EXISTS ${names.map((n) => `paraf_${n}`).join(', ')}`);
    await drop();
    try {
      await new PostgresStore(pool).migrate();
      const result = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE tablename = ANY($1) ORDER BY 1`,
        [names.map((n) => `paraf_${n}`)],
      );
      expect(result.rows).toHaveLength(names.length);
    } finally {
      await drop();
    }
  });

  it('rejects unsafe table prefixes', () => {
    for (const bad of ['Paraf_', 'paraf; DROP TABLE x;--', '1paraf_', 'a'.repeat(32)]) {
      expect(() => new PostgresStore(pool, { tablePrefix: bad })).toThrow(TypeError);
    }
  });

  it('ships schema.postgres.sql matching the migrations', () => {
    const file = readFileSync(new URL('../schema.postgres.sql', import.meta.url), 'utf8');
    expect(file).toBe(schemaSql());
  });

  it('works on a database set up from the raw SQL file', async () => {
    await pool.query(schemaSql(prefix));
    const store = new PostgresStore(pool, { tablePrefix: prefix });
    await store.migrate(); // already applied: nothing to do
    await store.saveFlowVersion(flowVersion(1));
    const state = instanceState();
    await store.createInstance(state, []);
    expect(await store.getInstance(state.instance.id)).toEqual(state);
  });
});

describe('PostgresStore errors', () => {
  const store = () => new PostgresStore(pool, { tablePrefix: 'paraf_errors_' });

  beforeEach(async () => {
    await dropTables(pool, 'paraf_errors_');
    await store().migrate();
  });

  it('passes database errors through', async () => {
    const tooLong = 'x'.repeat(300);
    await expect(store().saveFlowVersion(flowVersion(1, { name: tooLong }))).rejects.toThrow(
      /too long/,
    );
    await expect(store().setActiveVersion(tooLong, 1)).rejects.toThrow(/too long/);
    await store().saveFlowVersion(flowVersion(1));
    const state = instanceState({ subject: { type: tooLong, id: '1' } });
    await expect(store().createInstance(state, [])).rejects.toThrow(/too long/);
    await dropTables(pool, 'paraf_errors_');
  });

  it('rolls back a failed read snapshot', async () => {
    await dropTables(pool, 'paraf_errors_');
    await expect(store().getInstance(instanceState().instance.id)).rejects.toThrow(
      /does not exist/,
    );
  });
});
