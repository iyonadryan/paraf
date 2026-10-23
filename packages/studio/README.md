# @paraf/studio

**Paraf Studio** is the [Paraf](../../README.md) flow editor as a ready-made web app. Start it next
to your app (like Prisma Studio or Swagger UI), open the link, and edit, publish, and roll back
approval flows. It uses **your engine and your database**, so a published flow is immediately
the version your app runs.

- Runs on its own port (default **7272**) or inside your Express, Fastify, or Hono app.
- Only reachable from your own computer, and opened with a secret link.
- Turned off when `NODE_ENV` is `production`, unless you turn it on.
- Shows which database you are publishing to, e.g. a red **PRODUCTION** badge.
- Keeps a history of versions with who published them, when, and why, and rolls back in one
  click.

> [!WARNING]
> Early development. The API may still change before `1.0.0`.

## Requirements

- Node.js 24 or newer.
- An engine from `@paraf/core`, usually with `@paraf/postgres` or `@paraf/mysql`.
- Only to mount the studio in your app: Express 4.18+, Fastify 5+, or Hono 4.8+. On its own
  port it needs no framework.

## Quick start

1. Install it (as a dev dependency if you only run it in development):

   ```sh
   npm install --save-dev @paraf/studio
   ```

2. Start it where your app creates its engine, **after** registering your approver types and
   chains (the editor offers exactly those):

   ```ts
   import { createEngine } from '@paraf/core';
   import { PostgresStore } from '@paraf/postgres';
   import { startStudio } from '@paraf/studio';

   const engine = createEngine({ store: new PostgresStore(pool) }); // pool from DATABASE_URL
   engine.registerApproverType('role', findUsersByRole, { label: 'Role', configSchema: {...} });
   engine.registerChain('supervisor', supervisorOf, { label: 'Reporting line' });

   if (process.env.NODE_ENV !== 'production') {
     await startStudio({ engine, label: process.env.APP_ENV ?? 'development' });
   }
   ```

3. Start your app. The terminal shows the link:

   ```
   Paraf Studio: http://localhost:7272/?token=Xb3k…  (publishes to: development)
   ```

4. Open the link. The token is stored as a cookie in that browser, so later you can open
   `http://localhost:7272` directly.

In the studio you can:

- see every flow with its active and latest version, and create new ones (from scratch, a
  template, or an imported JSON file);
- edit a flow in the visual editor, with the same validation the engine uses;
- **Publish** it with release notes. New submissions use the new version right away; documents
  already in progress keep the version they started with;
- open **Versions** to see the history, load an old version into the editor, or **Make active**
  to roll back.

## Editing the flows of another environment

The studio writes to whatever database your engine uses. To change the flows of staging or
production, run your app locally with that environment's database and a clear label:

```sh
# .env.production-flows (never commit real credentials)
DATABASE_URL=postgres://…production…
APP_ENV=PRODUCTION
```

```sh
NODE_ENV=development node --env-file=.env.production-flows server.js
```

The header then shows a red **PRODUCTION** badge, and the publish dialog says "Publishing to
PRODUCTION". (Any label containing "prod" is shown in red.)

> [!IMPORTANT]
> The approver types and chains come from the code running on your computer. **Deploy code
> first, then publish flows that use it.** A flow that uses an approver type your production
> code does not have yet is accepted by your local studio but fails when production runs it.

If a published version turns out wrong, open **Versions** and use **Make active** on the
previous one. Nothing is deleted; versions are immutable.

## `startStudio` options

| Option    | Default                               | Description                                                                      |
| --------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| `engine`  | (required)                            | Your engine, with approver types, chains, and operators registered.              |
| `label`   | none                                  | Where flows are published, e.g. `"staging"` or `"PRODUCTION"`.                   |
| `port`    | `PARAF_STUDIO_PORT`, else `7272`      | When the port is taken, the next free one (up to 10 further) is used.            |
| `host`    | `127.0.0.1`                           | `0.0.0.0` makes it reachable from other computers (the token is still required). |
| `token`   | `PARAF_STUDIO_TOKEN`, else random     | The secret in the link. Set it to keep the same link across restarts.            |
| `user`    | your operating-system user name       | `{ id, name? }`, recorded as the publisher of new versions.                      |
| `enabled` | on, unless `NODE_ENV` is `production` | `true` turns it on in production too; `false` turns it off.                      |
| `log`     | `console.log`                         | Where the start-up message goes.                                                 |

`startStudio` returns `{ url, port, close() }`, or `null` when the studio is turned off.

## Inside your app (Express, Fastify, Hono)

If you cannot open another port (some hosting platforms only expose one), mount the studio in
your app instead. You then decide who may use it with `authorize`, typically with your existing
login. It returns the user (recorded as the publisher), `true` (allowed, anonymous), or a falsy
value (refused with 403).

**Express**

```ts
import { parafStudio } from '@paraf/studio/express';

app.use(
  '/paraf',
  parafStudio({
    engine,
    label: 'staging',
    authorize: (req) => req.user?.role === 'developer' && { id: req.user.id, name: req.user.name },
  }),
);
```

**Fastify**

```ts
import { parafStudio } from '@paraf/studio/fastify';

await app.register(
  parafStudio({ engine, authorize: (request) => request.user?.isDeveloper === true }),
  { prefix: '/paraf' },
);
```

**Hono**

```ts
import { parafStudio } from '@paraf/studio/hono';

app.route('/paraf', parafStudio({ engine, authorize: (c) => c.get('user')?.isDeveloper === true }));
```

Then open `/paraf/` in your app. Mounted studios follow the same `enabled` rule: when
`NODE_ENV` is `production` they are off (Express passes requests on, Fastify and Hono add no
routes) unless you pass `enabled: true`. Requests that change data must carry the
`x-paraf-studio` header, which the studio page sends and other sites cannot, so your session
cookie cannot be misused from another site.

Another framework? `createStudioHandler(options)` returns a function from a standard `Request`
(plus the path below the mount point and the user) to a `Response`; the adapters above are
about 30 lines each around it.

## Troubleshooting

- **"Paraf Studio is locked"**: open the link printed in the terminal (with `?token=`). After a
  restart without a fixed `token`, the link changes.
- **The port is different from 7272**: 7272 was taken; the terminal shows the port used. Set
  `port` (or `PARAF_STUDIO_PORT`) to choose another.
- **An approver type is missing in the editor**: register it before calling `startStudio`, and
  restart the app after adding one.
- **Nothing starts in production**: that is the default. Pass `enabled: true` only if you
  really want the studio there, and protect it with `authorize`.
