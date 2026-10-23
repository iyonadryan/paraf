// Runs the example end to end against PostgreSQL and checks the results (used in CI).
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createApp, createParaf } from './app.ts';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    process.env.PARAF_POSTGRES_URL ??
    'postgres://postgres:paraf@localhost:55432/paraf_test',
});
const server = createApp(pool, await createParaf(pool)).listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, user?: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

try {
  // Above 10,000,000: manager, director, then two from finance.
  const created = await call('POST', '/purchase-requests', 'u7', {
    title: 'Laptop',
    amount: 25_000_000,
  });
  assert.equal(created.status, 201);
  const { id, instanceId } = created.body as { id: string; instanceId: string };

  const inbox = await call('GET', '/inbox', 'm1');
  assert.ok(
    (inbox.body as unknown as { instanceId: string }[]).some(
      (item) => item.instanceId === instanceId,
    ),
  );

  assert.equal((await call('POST', `/approvals/${instanceId}/approve`, 'u7')).status, 403);
  await call('POST', `/approvals/${instanceId}/approve`, 'm1', { comment: 'OK' });
  await call('POST', `/approvals/${instanceId}/approve`, 'd1');
  await call('POST', `/approvals/${instanceId}/approve`, 'f1');
  const last = await call('POST', `/approvals/${instanceId}/approve`, 'f2');
  assert.equal(last.body.status, 'approved');

  const row = await call('GET', `/purchase-requests/${id}`);
  assert.equal(row.body.status, 'approved'); // updated by the instance.completed handler
  assert.equal(row.body.approval_status, 'approved');

  // A rejection.
  const second = await call('POST', '/purchase-requests', 'u7', {
    title: 'Chair',
    amount: 900_000,
  });
  const rejected = await call(
    'POST',
    `/approvals/${second.body.instanceId as string}/reject`,
    'm1',
    {
      comment: 'Not this quarter',
    },
  );
  assert.equal(rejected.body.status, 'rejected');

  // Invalid documents are refused by the flow's variables.
  const invalid = await call('POST', '/purchase-requests', 'u7', {
    title: 'Desk',
    amount: 'a lot',
  });
  assert.equal(invalid.status, 400);
  assert.equal((await call('GET', '/inbox')).status, 401);

  // Paraf Studio answers (its page needs the built UI).
  const studio = await fetch(`${base}/paraf/api/session`);
  assert.equal(studio.status, 200);
  console.log('express-postgres: all checks passed');
} finally {
  server.close();
  await pool.end();
}
