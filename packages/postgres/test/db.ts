import { Pool } from 'pg';
import { PostgresStore } from '../src';

/** Started by `docker compose up -d --wait` (see docker-compose.yml). */
export const DATABASE_URL =
  process.env.PARAF_POSTGRES_URL ?? 'postgres://postgres:paraf@localhost:55432/paraf_test';

export function createPool(): Pool {
  return new Pool({ connectionString: DATABASE_URL, max: 10 });
}

/** Drops every table whose name starts with `prefix`. */
export async function dropTables(pool: Pool, prefix: string): Promise<void> {
  const tables = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE $1`,
    [`${prefix.replace(/_/g, '\\_')}%`],
  );
  for (const { tablename } of tables.rows) {
    await pool.query(`DROP TABLE IF EXISTS ${tablename} CASCADE`);
  }
}

export { PostgresStore };
