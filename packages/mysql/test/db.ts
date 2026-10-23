import { createPool as createMySqlPool } from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { MySqlStore } from '../src';

/** Started by `docker compose up -d --wait` (see docker-compose.yml). */
export const DATABASE_URL =
  process.env.PARAF_MYSQL_URL ?? 'mysql://root:paraf@localhost:53306/paraf_test';

export function createPool(): Pool {
  return createMySqlPool({ uri: DATABASE_URL, connectionLimit: 10 });
}

/** Drops every table whose name starts with `prefix`. */
export async function dropTables(pool: Pool, prefix: string): Promise<void> {
  const [rows] = await pool.query(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name LIKE ?`,
    [`${prefix.replace(/_/g, '\\_')}%`],
  );
  const names = (rows as { name: string }[]).map((row) => row.name);
  if (names.length === 0) return;
  // FOREIGN_KEY_CHECKS is per session, so use one connection.
  const connection = await pool.getConnection();
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  await connection.query(`DROP TABLE IF EXISTS ${names.join(', ')}`);
  await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  connection.release();
}

export { MySqlStore };
