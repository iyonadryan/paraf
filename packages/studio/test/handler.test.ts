import { MemoryStore } from '@paraf/core';
import { createStudioHandler, isStudioEnabled } from '../src/handler';
import { createTestEngine, sampleFlow, setupHandler } from './fixtures';

describe('UI files', () => {
  it('redirects the mount point to a trailing slash, keeping the query', async () => {
    const { handler } = await setupHandler();
    const response = await handler(new Request('http://localhost/paraf?x=1'), {
      path: '/',
      user: null,
    });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/paraf/?x=1');
  });

  it('serves the page with security headers, and assets with long caching', async () => {
    const { call } = await setupHandler();
    const page = await call('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await page.text()).toContain('<title>Fixture</title>');

    const script = await call('/assets/app.js');
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(script.headers.get('x-frame-options')).toBeNull();
    expect((await call('/style.css')).headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect((await call('/data.bin')).headers.get('content-type')).toBe('application/octet-stream');
    expect((await call('/', { method: 'HEAD' })).status).toBe(200);
  });

  it('answers 404 for missing files and paths outside the UI folder, 405 for writes', async () => {
    const { call } = await setupHandler();
    expect((await call('/missing.js')).status).toBe(404);
    expect((await call('/../handler.test.ts')).status).toBe(404);
    expect((await call('/', { method: 'POST' })).status).toBe(405);
  });

  it('finds the built UI next to the package by default', async () => {
    const handler = createStudioHandler({ engine: createTestEngine() });
    const response = await handler(new Request('http://localhost/no-such-file'), {
      path: '/no-such-file',
      user: null,
    });
    expect(response.status).toBe(404);
  });
});

describe('API', () => {
  it('describes the session with resolved approver type options', async () => {
    const { call } = await setupHandler({ label: 'PRODUCTION' });
    const session = (await (await call('/api/session')).json()) as Record<string, unknown>;
    expect(session.label).toBe('PRODUCTION');
    expect(session.user).toEqual({ id: 'dev-1' });
    expect(session.chains).toEqual([{ name: 'supervisor', label: 'Reporting' }]);
    expect(session.operators).toEqual(['startsWith']);
    const role = (
      session.approverTypes as { type: string; configSchema?: Record<string, unknown> }[]
    ).find((type) => type.type === 'role');
    expect(role?.configSchema).toEqual({
      value: {
        type: 'multiselect',
        label: 'Roles',
        options: [{ value: 'manager', label: 'Manager' }],
      },
      note: { type: 'text', label: 'Note' },
    });
    const anonymous = await setupHandler();
    const noLabel = (await (await anonymous.call('/api/session', {}, null)).json()) as Record<
      string,
      unknown
    >;
    expect(noLabel.label).toBeNull();
    expect(noLabel.user).toBeNull();
  });

  it('lists flows and one flow with its versions and running documents', async () => {
    const { call, engine } = await setupHandler();
    await engine.start('purchase-request', {
      subject: { type: 'pr', id: '1' },
      requester: { id: 'u1' },
    });
    expect(await (await call('/api/flows')).json()).toEqual([
      { id: 'purchase-request', name: 'Purchase request', activeVersion: 1, latestVersion: 1 },
    ]);
    const detail = await call('/api/flows/purchase-request');
    expect(detail.headers.get('cache-control')).toBe('no-store');
    expect(await detail.json()).toEqual({
      id: 'purchase-request',
      activeVersion: 1,
      versions: [
        {
          version: 1,
          name: 'Purchase request',
          createdBy: 'seed',
          notes: 'First',
          createdAt: expect.any(String),
        },
      ],
      runningInstances: 1,
    });
    expect(await (await call('/api/flows/purchase-request/versions/1')).json()).toMatchObject({
      id: 'purchase-request',
      version: 1,
    });
  });

  it('reports a flow without an active version', async () => {
    const store = new MemoryStore();
    await store.saveFlowVersion({ ...sampleFlow(), version: 1 });
    const { call } = await setupHandler({ engine: createTestEngine(store) });
    expect(await (await call('/api/flows/purchase-request')).json()).toMatchObject({
      activeVersion: null,
    });
  });

  it('answers 404 for unknown flows, versions and routes', async () => {
    const { call, post } = await setupHandler();
    expect((await call('/api/flows/missing')).status).toBe(404);
    expect((await call('/api/flows/purchase-request/versions/9')).status).toBe(404);
    expect(await (await call('/api/nothing')).json()).toEqual({ error: 'Not found.' });
    expect((await call('/api/flows/purchase-request/versions')).status).toBe(404);
    expect((await post('/api/flows/purchase-request/archive', {})).status).toBe(404);
    expect(
      (await call('/api/flows', { method: 'DELETE', headers: { 'x-paraf-studio': '1' } })).status,
    ).toBe(404);
    expect((await post('/api/flows/purchase-request/active', { version: 9 })).status).toBe(404);
  });

  it('publishes a flow with the user and trimmed notes', async () => {
    const { post, engine } = await setupHandler();
    const response = await post('/api/flows', {
      flow: sampleFlow({ name: 'Renamed' }),
      notes: '  Rename  ',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ version: 2, name: 'Renamed' });
    await post('/api/flows', { flow: sampleFlow(), notes: ' ' }, null);
    expect(await engine.listFlowVersions('purchase-request')).toMatchObject([
      { version: 3, createdBy: null, notes: null },
      { version: 2, createdBy: 'dev-1', notes: 'Rename' },
      { version: 1 },
    ]);
  });

  it('rejects invalid flows with their issues', async () => {
    const { post } = await setupHandler();
    const response = await post('/api/flows', { flow: { ...sampleFlow(), start: 'ghost' } });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { issues: { code: string }[] };
    expect(body.issues.map((issue) => issue.code)).toContain('UNKNOWN_NODE_REFERENCE');
  });

  it('rejects malformed requests', async () => {
    const { call, post } = await setupHandler();
    expect((await post('/api/flows', 'not json')).status).toBe(400);
    expect(await (await post('/api/flows', '[1]')).json()).toEqual({
      error: 'The request body must be a JSON object.',
    });
    expect((await post('/api/flows', { flow: 'x' })).status).toBe(400);
    expect((await post('/api/flows/purchase-request/active', { version: '1' })).status).toBe(400);
    expect((await post('/api/flows', 'x'.repeat(1_000_001))).status).toBe(413);
    const noHeader = await call('/api/flows', { method: 'POST', body: '{}' });
    expect(noHeader.status).toBe(403);
  });

  it('activates a version', async () => {
    const { post, engine } = await setupHandler();
    await post('/api/flows', { flow: sampleFlow({ name: 'v2' }) });
    expect(await (await post('/api/flows/purchase-request/active', { version: 1 })).json()).toEqual(
      {
        activeVersion: 1,
      },
    );
    expect((await engine.getActiveFlow('purchase-request'))?.version).toBe(1);
  });

  it('hides unexpected errors behind a 500', async () => {
    const engine = createTestEngine();
    vi.spyOn(engine, 'listFlows').mockRejectedValue(new Error('database down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { call } = await setupHandler({ engine });
    const response = await call('/api/flows');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal error; see the server log.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('isStudioEnabled', () => {
  it('is off in production unless enabled explicitly', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(isStudioEnabled({})).toBe(false);
    expect(isStudioEnabled({ enabled: true })).toBe(true);
    vi.stubEnv('NODE_ENV', 'development');
    expect(isStudioEnabled({})).toBe(true);
    expect(isStudioEnabled({ enabled: false })).toBe(false);
    vi.unstubAllEnvs();
  });
});
