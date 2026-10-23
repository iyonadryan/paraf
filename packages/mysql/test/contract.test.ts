import { describeStoreContract } from '@paraf/store-tests';
import { createPool, dropTables, MySqlStore } from './db';

const prefix = 'paraf_contract_';
const pool = createPool();
const tables = ['approvers', 'steps', 'audit', 'instances', 'flow_heads', 'flows'];

describeStoreContract('MySqlStore', {
  async setup() {
    await dropTables(pool, prefix);
    await new MySqlStore(pool, { tablePrefix: prefix }).migrate();
  },
  async create() {
    const connection = await pool.getConnection();
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of tables) await connection.query(`TRUNCATE TABLE ${prefix}${table}`);
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    connection.release();
    return new MySqlStore(pool, { tablePrefix: prefix });
  },
  async teardown() {
    await pool.end();
  },
});
