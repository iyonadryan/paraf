import { readFileSync } from 'node:fs';
import { createEngine } from '@paraf/core';
import { flowVersion, instanceState } from '@paraf/store-tests';
import { createPool as createMySqlPool } from 'mysql2/promise';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { schemaSql } from '../src/schema';
import { createPool, DATABASE_URL, dropTables, MySqlStore } from './db';

const pool = createPool();
const prefix = 'paraf_migrate_';

afterAll(async () => {
  await dropTables(pool, prefix);
  await pool.end();
});

async function tables(): Promise<string[]> {
  const [rows] = await pool.query(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name LIKE ? ORDER BY 1`,
    [`${prefix.replace(/_/g, '\\_')}%`],
  );
  return (rows as { name: string }[]).map((row) => row.name);
}

describe('MySqlStore migrations', () => {
  beforeEach(async () => {
    await dropTables(pool, prefix);
  });

  it('creates InnoDB tables with the configured prefix and records the version', async () => {
    await new MySqlStore(pool, { tablePrefix: prefix }).migrate();
    expect(await tables()).toEqual(
      ['approvers', 'audit', 'flow_heads', 'flows', 'instances', 'migrations', 'steps'].map(
        (table) => prefix + table,
      ),
    );
    const [engines] = await pool.query(
      `SELECT DISTINCT engine FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name LIKE ?`,
      [`${prefix.replace(/_/g, '\\_')}%`],
    );
    expect(engines).toEqual([{ ENGINE: 'InnoDB' }]);
    const [applied] = await pool.query(`SELECT version, name FROM ${prefix}migrations`);
    expect(applied).toEqual([
      { version: 1, name: 'initial schema' },
      { version: 2, name: 'flow version notes' },
    ]);
  });

  it('is idempotent and safe to run concurrently', async () => {
    const store = new MySqlStore(pool, { tablePrefix: prefix });
    await Promise.all([store.migrate(), store.migrate(), store.migrate()]);
    await store.migrate();
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${prefix}migrations`);
    expect(rows).toEqual([{ n: 2 }]);
  });

  it('can be retried after failing halfway', async () => {
    // A view with a table's name makes the migration fail after creating some tables.
    await pool.query(`CREATE VIEW ${prefix}steps AS SELECT 1 AS id`);
    const store = new MySqlStore(pool, { tablePrefix: prefix });
    await expect(store.migrate()).rejects.toThrow();
    await pool.query(`DROP VIEW ${prefix}steps`);
    await store.migrate();
    expect(await tables()).toHaveLength(7);
  });

  it('uses the paraf_ prefix by default', async () => {
    const names = ['audit', 'approvers', 'steps', 'instances', 'flow_heads', 'flows', 'migrations'];
    const drop = () =>
      pool.query(`DROP TABLE IF EXISTS ${names.map((n) => `paraf_${n}`).join(', ')}`);
    await drop();
    try {
      await new MySqlStore(pool).migrate();
      const [rows] = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name IN (?)`,
        [names.map((n) => `paraf_${n}`)],
      );
      expect(rows).toHaveLength(names.length);
    } finally {
      await drop();
    }
  });

  it('rejects unsafe table prefixes', () => {
    for (const bad of ['Paraf_', 'paraf`; DROP TABLE x;--', '1paraf_', 'a'.repeat(32)]) {
      expect(() => new MySqlStore(pool, { tablePrefix: bad })).toThrow(TypeError);
    }
  });

  it('ships schema.mysql.sql matching the migrations', () => {
    const file = readFileSync(new URL('../schema.mysql.sql', import.meta.url), 'utf8');
    expect(file).toBe(schemaSql());
  });

  it('works on a database set up from the raw SQL file', async () => {
    const multi = createMySqlPool({ uri: DATABASE_URL, multipleStatements: true });
    await multi.query(schemaSql(prefix));
    await multi.end();
    const store = new MySqlStore(pool, { tablePrefix: prefix });
    await store.migrate(); // already applied: nothing to do
    await store.saveFlowVersion(flowVersion(1));
    const state = instanceState();
    await store.createInstance(state, []);
    expect(await store.getInstance(state.instance.id)).toEqual(state);
  });
});

describe('MySqlStore data handling', () => {
  beforeEach(async () => {
    await dropTables(pool, prefix);
    await new MySqlStore(pool, { tablePrefix: prefix }).migrate();
  });

  it('round-trips times exactly, whatever the pool time zone', async () => {
    const shifted = createMySqlPool({ uri: DATABASE_URL, timezone: '+07:00', jsonStrings: true });
    const store = new MySqlStore(shifted, { tablePrefix: prefix });
    await store.saveFlowVersion(flowVersion(1));
    const state = instanceState();
    await store.createInstance(state, []);
    expect(await store.getInstance(state.instance.id)).toEqual(state);
    expect(
      await new MySqlStore(pool, { tablePrefix: prefix }).getInstance(state.instance.id),
    ).toEqual(state);
    await shifted.end();
  });

  it('needs UUID ids', async () => {
    const store = new MySqlStore(pool, { tablePrefix: prefix });
    const engine = createEngine({ store, generateId: () => 'not-a-uuid' });
    engine.registerApproverType('role', () => ['f1', 'f2']);
    await engine.publishFlow({ ...flowVersion(1), id: 'other' });
    await expect(
      engine.start('other', { subject: { type: 'doc', id: '1' }, requester: { id: 'u7' } }),
    ).rejects.toThrow('MySqlStore needs UUID ids, got "not-a-uuid"');
  });

  it('passes database errors through', async () => {
    const store = new MySqlStore(pool, { tablePrefix: prefix });
    const tooLong = 'x'.repeat(300);
    await expect(store.saveFlowVersion(flowVersion(1, { name: tooLong }))).rejects.toThrow(
      /too long/,
    );
    await expect(store.setActiveVersion(tooLong, 1)).rejects.toThrow(/too long/);
    await store.saveFlowVersion(flowVersion(1));
    await expect(
      store.createInstance(instanceState({ subject: { type: tooLong, id: '1' } }), []),
    ).rejects.toThrow(/too long/);
  });

  it('rolls back a failed read snapshot', async () => {
    await dropTables(pool, prefix);
    await expect(
      new MySqlStore(pool, { tablePrefix: prefix }).getInstance(instanceState().instance.id),
    ).rejects.toThrow(/doesn't exist/);
  });
});
