import { describeStoreContract } from '@paraf/store-tests';
import { createPool, dropTables, PostgresStore } from './db';

const prefix = 'paraf_contract_';
const pool = createPool();

describeStoreContract('PostgresStore', {
  async setup() {
    await dropTables(pool, prefix);
    await new PostgresStore(pool, { tablePrefix: prefix }).migrate();
  },
  async create() {
    await pool.query(
      `TRUNCATE ${['flows', 'flow_heads', 'instances', 'steps', 'approvers', 'audit']
        .map((table) => prefix + table)
        .join(', ')} RESTART IDENTITY CASCADE`,
    );
    return new PostgresStore(pool, { tablePrefix: prefix });
  },
  async teardown() {
    await pool.end();
  },
});
