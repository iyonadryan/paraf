# @paraf/mysql

MySQL storage adapter for [Paraf](../../README.md). Requires `mysql2` (3.9+) and MySQL 8.0.19+
with InnoDB (tested on 8.4).

```ts
import { createEngine } from '@paraf/core';
import { MySqlStore } from '@paraf/mysql';
import mysql from 'mysql2/promise';

const store = new MySqlStore(mysql.createPool(process.env.DATABASE_URL));
await store.migrate(); // creates or upgrades the paraf_* tables; safe on every startup

const engine = createEngine({ store });
```

- `tablePrefix` (default `paraf_`) changes every table and index name.
- Prefer managing the schema yourself? Apply [`schema.mysql.sql`](./schema.mysql.sql)
  (same as `migrate()` with the default prefix); `migrate()` will then find nothing to do.
- IDs are stored as `BINARY(16)` and converted to UUID strings, so keep the engine's default
  UUID v7 ids. Times are `DATETIME(3)` in UTC, whatever the pool's `timezone` setting.
- One active instance per subject is enforced by a unique `active_subject_key` column, which
  is `NULL` once the instance has finished.
- MySQL commits DDL immediately, so a migration is not atomic; its statements are idempotent
  and a failed `migrate()` can simply be run again.
