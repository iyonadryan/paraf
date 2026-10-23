# @paraf/postgres

PostgreSQL storage adapter for [Paraf](../../README.md). Requires Node.js 24+, `pg` (8.11+), and
PostgreSQL 12+ (tested on 16).

```sh
npm install @paraf/core @paraf/postgres pg
```

```ts
import { createEngine } from '@paraf/core';
import { PostgresStore } from '@paraf/postgres';
import { Pool } from 'pg';

const store = new PostgresStore(new Pool({ connectionString: process.env.DATABASE_URL }));
await store.migrate(); // creates or upgrades the paraf_* tables; safe on every startup

const engine = createEngine({ store });
```

- `tablePrefix` (default `paraf_`) changes every table and index name.
- Prefer managing the schema yourself? Apply [`schema.postgres.sql`](./schema.postgres.sql)
  (same as `migrate()` with the default prefix); `migrate()` will then find nothing to do.
- IDs are stored as `UUID`, so keep the engine's default UUID v7 ids.
- One active instance per subject is enforced by a partial unique index.
