// An Express API that uses Paraf for the approval of purchase requests.
//
// - Your own tables (`employees`, `purchase_requests`) stay yours. Paraf keeps its state in the
//   `paraf_*` tables and points at your rows through the instance's subject
//   (`subject_type = 'purchase_request'`, `subject_id = purchase_requests.id`).
// - Approver resolvers query your tables, so approvers are found when a step starts.
// - The `instance.completed` event copies the outcome back to `purchase_requests.status`.
// - Paraf Studio is mounted at /paraf for editing the flow (development only by default).
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import {
  ActiveInstanceExistsError,
  createEngine,
  FlowNotFoundError,
  InstanceNotFoundError,
  NotAuthorizedError,
  ParafError,
  validateDocument,
} from '@paraf/core';
import type { FlowDefinition, JsonObject, ParafEngine } from '@paraf/core';
import { PostgresStore } from '@paraf/postgres';
import { parafStudio } from '@paraf/studio/express';

/** The flow published when the database has none yet; afterwards edit it in Paraf Studio. */
export const purchaseFlow: FlowDefinition = {
  id: 'purchase-request',
  name: 'Purchase request',
  start: 'manager',
  variables: [
    { key: 'amount', label: 'Amount', type: 'number', required: true },
    { key: 'title', label: 'Title', type: 'text', required: true },
  ],
  nodes: {
    manager: {
      type: 'approval',
      label: 'Direct manager',
      approvers: [{ type: 'supervisor', level: 1 }],
      mode: 'any',
      excludeRequester: true,
      next: 'check_amount',
      onReject: 'rejected',
    },
    check_amount: {
      type: 'condition',
      rules: [{ when: { '>': [{ var: 'amount' }, 10_000_000] }, next: 'director' }],
      else: 'finance',
    },
    director: {
      type: 'approval',
      label: 'Director',
      approvers: [{ type: 'role', value: 'director' }],
      mode: 'any',
      next: 'finance',
      onReject: 'rejected',
    },
    finance: {
      type: 'approval',
      label: 'Finance',
      approvers: [{ type: 'role', value: 'finance' }],
      mode: { minimum: 2 },
      next: 'approved',
      onReject: 'rejected',
    },
    approved: { type: 'end', result: 'approved' },
    rejected: { type: 'end', result: 'rejected' },
  },
};

/** Creates your tables (if missing) and a few employees. */
async function setUpAppTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      role        TEXT NOT NULL,
      manager_id  TEXT REFERENCES employees (id)
    );
    CREATE TABLE IF NOT EXISTS purchase_requests (
      id            SERIAL PRIMARY KEY,
      title         TEXT NOT NULL,
      amount        NUMERIC NOT NULL,
      requester_id  TEXT NOT NULL REFERENCES employees (id),
      status        TEXT NOT NULL DEFAULT 'in_approval',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO employees (id, name, role, manager_id) VALUES
      ('d1', 'Sari', 'director', NULL),
      ('m1', 'Budi', 'manager', 'd1'),
      ('u7', 'Dimas', 'staff', 'm1'),
      ('f1', 'Fajar', 'finance', 'd1'),
      ('f2', 'Tika', 'finance', 'd1')
    ON CONFLICT (id) DO NOTHING;
  `);
}

/** The engine, with resolvers that query your tables. */
export async function createParaf(pool: Pool): Promise<ParafEngine> {
  const store = new PostgresStore(pool);
  await store.migrate(); // creates or upgrades the paraf_* tables; safe on every start
  await setUpAppTables(pool);

  const engine = createEngine({ store });

  engine.registerApproverType(
    'role',
    async ({ value }) => {
      const roles = Array.isArray(value) ? value : [value];
      const result = await pool.query<{ id: string }>(
        'SELECT id FROM employees WHERE role = ANY($1) ORDER BY id',
        [roles],
      );
      return result.rows.map((row) => row.id);
    },
    {
      label: 'Role',
      description: 'Everyone with one of these roles',
      configSchema: {
        value: {
          type: 'multiselect',
          label: 'Roles',
          required: true,
          // Loaded when the editor opens, from your data.
          options: async () => {
            const result = await pool.query<{ role: string }>(
              'SELECT DISTINCT role FROM employees ORDER BY role',
            );
            return result.rows.map(({ role }) => ({ value: role, label: role }));
          },
        },
      },
    },
  );

  engine.registerApproverType(
    'supervisor',
    async ({ level }, { requester }) => {
      let current: string | null = requester.id;
      for (let i = 0; i < Number(level ?? 1) && current !== null; i++) {
        const result: { rows: { manager_id: string | null }[] } = await pool.query(
          'SELECT manager_id FROM employees WHERE id = $1',
          [current],
        );
        current = result.rows[0]?.manager_id ?? null;
      }
      return current === null ? [] : [current];
    },
    {
      label: 'Manager',
      description: "The requester's manager, level 1, 2, ...",
      configSchema: { level: { type: 'number', label: 'Level', required: true } },
    },
  );

  engine.registerChain(
    'reporting-line',
    async (userId) => {
      const result = await pool.query<{ manager_id: string | null }>(
        'SELECT manager_id FROM employees WHERE id = $1',
        [userId],
      );
      return result.rows[0]?.manager_id ?? null;
    },
    { label: 'Reporting line' },
  );

  // Keep your table in sync with the approval.
  engine.on('instance.completed', async ({ instance }) => {
    if (instance.subject.type !== 'purchase_request') return;
    await pool.query('UPDATE purchase_requests SET status = $1 WHERE id = $2', [
      instance.status,
      Number(instance.subject.id),
    ]);
  });
  // Send notifications here (email, chat, ...).
  engine.on('approval.required', ({ instance, groups }) => {
    const users = groups.flatMap((group) => group.userIds).join(', ');
    console.log(`[notify] ${users}: please review ${instance.subject.type} ${instance.subject.id}`);
  });

  if (!(await engine.getActiveFlow(purchaseFlow.id))) {
    await engine.publishFlow(purchaseFlow, { createdBy: 'setup', notes: 'Initial flow' });
  }
  return engine;
}

/** Stand-in for your authentication: the user ID in the `x-user` header. */
function currentUser(req: Request): string {
  const user = req.header('x-user');
  if (!user) throw new HttpError(401, 'Send the x-user header.');
  return user;
}

class HttpError extends Error {
  // A plain field: Node's built-in TypeScript support has no parameter properties.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** HTTP status for Paraf's typed errors. */
function statusOf(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof NotAuthorizedError) return 403;
  if (error instanceof InstanceNotFoundError || error instanceof FlowNotFoundError) return 404;
  if (error instanceof ActiveInstanceExistsError) return 409;
  if (error instanceof ParafError) return 400;
  return 500;
}

export function createApp(pool: Pool, engine: ParafEngine): express.Express {
  const app = express();
  app.use(express.json());

  // Submit a purchase request: your row first, then the approval for it.
  app.post('/purchase-requests', async (req, res) => {
    const requester = currentUser(req);
    const { title, amount } = req.body as { title: unknown; amount: unknown };
    const document = { title, amount } as JsonObject;
    // Check the input against the variables the active flow declares, before saving anything.
    const flow = await engine.getActiveFlow('purchase-request');
    const problems = validateDocument(document, flow?.variables);
    if (problems.length > 0) {
      throw new HttpError(400, problems.map((problem) => problem.message).join('; '));
    }
    const result = await pool.query<{ id: number }>(
      'INSERT INTO purchase_requests (title, amount, requester_id) VALUES ($1, $2, $3) RETURNING id',
      [title, amount, requester],
    );
    const id = String(result.rows[0]?.id);
    try {
      const instance = await engine.start('purchase-request', {
        subject: { type: 'purchase_request', id },
        requester: { id: requester },
        document,
      });
      res.status(201).json({ id, instanceId: instance.id, status: instance.status });
    } catch (error) {
      // E.g. nobody to approve: don't keep a request that never entered approval.
      await pool.query('DELETE FROM purchase_requests WHERE id = $1', [Number(id)]);
      throw error;
    }
  });

  // A purchase request with its approval: your row joined with paraf_instances.
  app.get('/purchase-requests/:id', async (req, res) => {
    const result = await pool.query(
      `SELECT pr.*, i.id AS instance_id, i.status AS approval_status
       FROM purchase_requests pr
       LEFT JOIN paraf_instances i
         ON i.subject_type = 'purchase_request' AND i.subject_id = pr.id::text
       WHERE pr.id = $1
       ORDER BY i.created_at DESC
       LIMIT 1`,
      [Number(req.params.id)],
    );
    if (result.rows.length === 0) throw new HttpError(404, 'No such purchase request.');
    res.json(result.rows[0]);
  });

  // What the current user has to approve.
  app.get('/inbox', async (req, res) => {
    const page = await engine.findPendingForUser(currentUser(req));
    res.json(
      page.items.map((item) => ({
        instanceId: item.instance.id,
        subject: item.instance.subject,
        step: item.nodeId,
        waitingSince: item.enteredAt,
      })),
    );
  });

  app.post('/approvals/:instanceId/:decision', async (req, res) => {
    const user = currentUser(req);
    const { comment } = (req.body ?? {}) as { comment?: string };
    const { instanceId, decision } = req.params;
    const instance =
      decision === 'approve'
        ? await engine.approve(instanceId, user, comment)
        : decision === 'reject'
          ? await engine.reject(instanceId, user, comment ?? '')
          : null;
    if (!instance) throw new HttpError(404, 'Use approve or reject.');
    res.json({ status: instance.status });
  });

  // Paraf Studio for editing the flow; off in production unless you pass `enabled: true`.
  app.use(
    '/paraf',
    parafStudio({
      engine,
      label: process.env.APP_ENV ?? 'development',
      // Replace with your login, e.g. `req.user?.role === 'developer' && { id: req.user.id }`.
      authorize: (req) =>
        req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1',
    }),
  );

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = statusOf(error);
    if (status === 500) console.error(error);
    res
      .status(status)
      .json({ error: status === 500 ? 'Internal error' : (error as Error).message });
  });
  return app;
}
