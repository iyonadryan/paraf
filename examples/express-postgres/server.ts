// Starts the example API on http://localhost:3000.
//
//   docker compose up -d --wait        # PostgreSQL from the repository's docker-compose.yml
//   pnpm build                         # the Paraf packages (and the studio UI)
//   pnpm --filter express-postgres start
import pg from 'pg';
import { createApp, createParaf } from './app.ts';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://postgres:paraf@localhost:55432/paraf_test',
});
const engine = await createParaf(pool);
const port = Number(process.env.PORT ?? 3000);

createApp(pool, engine).listen(port, () => {
  console.log(
    `API on http://localhost:${port}  ·  Paraf Studio on http://localhost:${port}/paraf/`,
  );
});
