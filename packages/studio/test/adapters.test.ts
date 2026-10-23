import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import type { ParafEngine } from '@paraf/core';
import { parafStudio as expressStudio } from '../src/express';
import type { ExpressStudioOptions } from '../src/express';
import { parafStudio as fastifyStudio } from '../src/fastify';
import type { FastifyStudioOptions } from '../src/fastify';
import { DISABLED_MESSAGE } from '../src/handler';
import { parafStudio as honoStudio } from '../src/hono';
import type { HonoStudioOptions } from '../src/hono';
import { createTestEngine, sampleFlow, UI_FIXTURE } from './fixtures';

const CSRF = { 'x-paraf-studio': '1', 'content-type': 'application/json' };
const publishBody = (name: string) => JSON.stringify({ flow: sampleFlow({ name }) });

/** Adds the internal `uiDir` option, so the fixture UI is served. */
function withFixture<T extends object>(options: T): T {
  return { ...options, uiDir: UI_FIXTURE };
}

async function seeded(): Promise<ParafEngine> {
  const engine = createTestEngine();
  await engine.publishFlow(sampleFlow());
  return engine;
}

describe('Express', () => {
  const servers: { close: () => void }[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  async function serve(app: express.Express): Promise<string> {
    const server = app.listen(0);
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('serves the studio at its mount path, with any body parser', async () => {
    const engine = await seeded();
    const options = (authorize: ExpressStudioOptions['authorize']) =>
      withFixture({ engine, authorize, label: 'staging' });
    const app = express();
    app.use('/plain', expressStudio(options(() => ({ id: 'dev-1' }))));
    app.use(
      '/json',
      express.json(),
      expressStudio(options(() => Promise.resolve({ id: 'dev-2' }))),
    );
    app.use('/text', express.text({ type: '*/*' }), expressStudio(options(() => true)));
    app.use('/raw', express.raw({ type: '*/*' }), expressStudio(options(() => true)));
    const base = await serve(app);

    const redirect = await fetch(`${base}/plain`, { redirect: 'manual' });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('/plain/');
    expect(await (await fetch(`${base}/plain/`)).text()).toContain('Fixture');
    const session = (await (await fetch(`${base}/plain/api/session`)).json()) as { label: string };
    expect(session.label).toBe('staging');

    for (const [prefix, version] of [
      ['plain', 2],
      ['json', 3],
      ['text', 4],
      ['raw', 5],
    ] as const) {
      const response = await fetch(`${base}/${prefix}/api/flows`, {
        method: 'POST',
        headers: CSRF,
        body: publishBody(prefix),
      });
      expect(await response.json()).toMatchObject({ version, name: prefix });
    }
    expect(await engine.listFlowVersions('purchase-request')).toMatchObject([
      { createdBy: null },
      { createdBy: null },
      { createdBy: 'dev-2' },
      { createdBy: 'dev-1' },
      { createdBy: null },
    ]);
  });

  it('accepts HTTP/1.0 clients without a Host header', async () => {
    const app = express();
    app.use(
      '/paraf',
      expressStudio(withFixture({ engine: await seeded(), authorize: () => true })),
    );
    const base = await serve(app);
    const port = Number(new URL(base).port);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.end('GET /paraf HTTP/1.0\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
      socket.on('end', () => {
        resolve(data);
      });
      socket.on('error', reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 308/);
    expect(response).toContain('location: /paraf/');
  });

  it('refuses users that authorize rejects, and passes errors on', async () => {
    const engine = await seeded();
    const app = express();
    app.use('/denied', expressStudio(withFixture({ engine, authorize: () => null })));
    app.use(
      '/broken',
      expressStudio(
        withFixture({
          engine,
          authorize: () => {
            throw new Error('auth service down');
          },
        }),
      ),
    );
    const base = await serve(app);
    const denied = await fetch(`${base}/denied/api/session`);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'You are not allowed to use Paraf Studio.' });
    expect((await fetch(`${base}/broken/`)).status).toBe(500);
  });

  it('passes every request on when disabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = express();
    app.use(
      '/paraf',
      expressStudio({ engine: await seeded(), authorize: () => true, enabled: false }),
    );
    app.use((_req, res) => {
      res.status(404).send('app 404');
    });
    const base = await serve(app);
    expect(await (await fetch(`${base}/paraf/`)).text()).toBe('app 404');
    expect(warn).toHaveBeenCalledWith(DISABLED_MESSAGE);
    warn.mockRestore();
  });
});

describe('Fastify', () => {
  async function app(options: Partial<FastifyStudioOptions> = {}) {
    const engine = await seeded();
    const fastify = Fastify();
    await fastify.register(
      fastifyStudio(withFixture({ engine, authorize: () => ({ id: 'dev-1' }), ...options })),
      { prefix: '/paraf' },
    );
    return { fastify, engine };
  }

  it('serves the studio under its prefix', async () => {
    const { fastify, engine } = await app();
    const redirect = await fastify.inject({ url: '/paraf' });
    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe('/paraf/');
    expect((await fastify.inject({ url: '/paraf/' })).body).toContain('Fixture');
    expect((await fastify.inject({ url: '/paraf/assets/app.js' })).headers['content-type']).toBe(
      'text/javascript; charset=utf-8',
    );
    const published = await fastify.inject({
      method: 'POST',
      url: '/paraf/api/flows',
      headers: CSRF,
      payload: publishBody('v2'),
    });
    expect(published.statusCode).toBe(201);
    expect((await engine.listFlowVersions('purchase-request'))[0]?.createdBy).toBe('dev-1');
    const empty = await fastify.inject({ method: 'POST', url: '/paraf/api/flows', headers: CSRF });
    expect(empty.statusCode).toBe(400);
  });

  it('refuses users that authorize rejects', async () => {
    const { fastify } = await app({ authorize: () => Promise.resolve(false) });
    expect((await fastify.inject({ url: '/paraf/api/session' })).statusCode).toBe(403);
  });

  it('adds no routes when disabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fastify } = await app({ enabled: false });
    expect((await fastify.inject({ url: '/paraf/' })).statusCode).toBe(404);
    expect(warn).toHaveBeenCalledWith(DISABLED_MESSAGE);
    warn.mockRestore();
  });
});

describe('Hono', () => {
  async function app(options: Partial<HonoStudioOptions> = {}) {
    const engine = await seeded();
    const hono = new Hono();
    hono.route(
      '/paraf',
      honoStudio(withFixture({ engine, authorize: () => ({ id: 'dev-1' }), ...options })),
    );
    return { hono, engine };
  }

  it('serves the studio where it is mounted', async () => {
    const { hono, engine } = await app();
    const redirect = await hono.request('/paraf');
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('/paraf/');
    expect(await (await hono.request('/paraf/')).text()).toContain('Fixture');
    const published = await hono.request('/paraf/api/flows', {
      method: 'POST',
      headers: CSRF,
      body: publishBody('v2'),
    });
    expect(published.status).toBe(201);
    expect((await engine.listFlowVersions('purchase-request'))[0]?.createdBy).toBe('dev-1');
  });

  it('refuses users that authorize rejects', async () => {
    const { hono } = await app({ authorize: () => undefined });
    expect((await hono.request('/paraf/api/session')).status).toBe(403);
  });

  it('has no routes when disabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { hono } = await app({ enabled: false });
    expect((await hono.request('/paraf/')).status).toBe(404);
    expect(warn).toHaveBeenCalledWith(DISABLED_MESSAGE);
    warn.mockRestore();
  });
});
