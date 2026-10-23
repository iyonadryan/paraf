# @paraf/mysql

MySQL storage adapter for [Paraf](../../README.md).

> [!WARNING]
> Early development. The API may still change before `1.0.0`.

## Quick start

Requires Node.js 24+, `mysql2` 3.9+, and MySQL 8.0.19+ with InnoDB (tested on 8.4).

```sh
npm install @paraf/core @paraf/mysql mysql2
```

```ts
import { createEngine } from '@paraf/core';
import { MySqlStore } from '@paraf/mysql';
import mysql from 'mysql2/promise';

const store = new MySqlStore(mysql.createPool(process.env.DATABASE_URL));
await store.migrate(); // creates or upgrades the paraf_* tables; safe on every startup

const engine = createEngine({ store });
```

Use the same pool as the rest of your app if you like: Paraf only touches its own `paraf_*`
tables.

## Options and schema

- `new MySqlStore(pool, { tablePrefix })`: `tablePrefix` (default `paraf_`) changes every table
  and index name (lowercase letters, digits, `_`; at most 31 characters).
- `migrate()` runs under a named lock, so several app instances may start at once. MySQL commits
  DDL immediately, so a migration is not atomic; its statements are idempotent and a failed
  `migrate()` can simply be run again.
- Prefer managing the schema yourself? Apply [`schema.mysql.sql`](./schema.mysql.sql) (the same
  as `migrate()` with the default prefix); `migrate()` then finds nothing to do.
- IDs are stored as `BINARY(16)` and returned as UUID strings, so keep the engine's default
  UUID v7 IDs. Times are `DATETIME(3)` in UTC, whatever the pool's `timezone` setting.
- One running instance per subject is enforced by a unique `active_subject_key` column, which
  is `NULL` once the instance has finished.

## Tables

The same tables as [`@paraf/postgres`](../postgres/README.md#tables), with MySQL types:

```mermaid
erDiagram
  paraf_flows ||--o| paraf_flow_heads : "active version"
  paraf_flows ||--o{ paraf_instances : "runs"
  paraf_instances ||--o{ paraf_steps : "has"
  paraf_steps ||--o{ paraf_approvers : "asks"
  paraf_instances ||--o{ paraf_audit : "records"

  paraf_flows {
    varchar flow_id PK
    int version PK
    varchar name
    json definition
    varchar created_by
    text notes
    datetime created_at
  }
  paraf_flow_heads {
    varchar flow_id PK
    int active_version FK
    datetime updated_at
  }
  paraf_instances {
    binary16 id PK
    varchar flow_id FK
    int flow_version FK
    varchar subject_type
    varchar subject_id
    varchar requester_id
    varchar status
    binary16 current_step_id
    int round
    json document
    int revision
    datetime created_at
    datetime updated_at
    datetime completed_at
    varchar active_subject_key UK
  }
  paraf_steps {
    binary16 id PK
    binary16 instance_id FK
    int position
    varchar node_id
    int iteration
    int chain_level
    int round
    varchar status
    json config
    datetime entered_at
    datetime due_at
    datetime completed_at
  }
  paraf_approvers {
    binary16 id PK
    binary16 step_id FK
    binary16 instance_id
    int position
    varchar group_id
    varchar user_id
    json source
    varchar status
    varchar delegated_from
    binary16 auto_from_step
    datetime decided_at
    text comment
  }
  paraf_audit {
    bigint seq
    binary16 id PK
    binary16 instance_id FK
    binary16 step_id
    varchar node_id
    varchar action
    varchar actor_id
    text comment
    json metadata
    datetime created_at
  }
```

Link your own tables through the subject. IDs are binary, so convert when you read them in SQL:

```sql
SELECT pr.*, i.status AS approval_status, BIN_TO_UUID(i.id) AS instance_id
FROM purchase_requests pr
LEFT JOIN paraf_instances i
  ON i.subject_type = 'purchase_request'
 AND i.subject_id = CAST(pr.id AS CHAR)
 AND i.status IN ('pending', 'in_progress', 'returned');
```
