import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { connect } from 'node:net';
import { userInfo } from 'node:os';
import { DISABLED_MESSAGE } from '../src/handler';
import { startStudio } from '../src/node';
import type { RunningStudio, StartStudioOptions } from '../src/node';
import { createTestEngine, sampleFlow, UI_FIXTURE } from './fixtures';

const running: RunningStudio[] = [];

async function start(options: Partial<StartStudioOptions> = {}) {
  const log = vi.fn();
  const engine = createTestEngine();
  await engine.publishFlow(sampleFlow());
  const studio = await startStudio({
    engine,
    port: 0,
    token: 'secret',
    log,
    ...options,
    // Internal: serve the test fixture instead of the built UI.
    ...({ uiDir: UI_FIXTURE } as object),
  });
  if (studio) running.push(studio);
  return { studio, log, base: studio ? `http://127.0.0.1:${studio.port}` : '' };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((studio) => studio.close()));
  vi.unstubAllEnvs();
});

/** A random high port, likely free together with the ten after it. */
function randomPort(): number {
  return 40_000 + Math.floor(Math.random() * 9_000);
}

function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.end(text);
    });
    let data = '';
    socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
    socket.on('end', () => {
      resolve(data);
    });
    socket.on('error', reject);
  });
}

describe('startStudio', () => {
  it('is unlocked by the token link and locked otherwise', async () => {
    const { studio, base, log } = await start({ label: 'staging' });
    expect(studio?.url).toBe(`http://localhost:${studio?.port}/?token=secret`);
    expect(log).toHaveBeenCalledWith(`Paraf Studio: ${studio?.url}  (publishes to: staging)`);

    const locked = await fetch(`${base}/`);
    expect(locked.status).toBe(401);
    expect(await locked.text()).toContain('Paraf Studio is locked');
    const lockedApi = await fetch(`${base}/api/flows`);
    expect(await lockedApi.json()).toEqual({ error: 'Open the link printed in the terminal.' });
    expect((await fetch(`${base}/?token=wrong`)).status).toBe(401);

    const unlock = await fetch(`${base}/?token=secret&tab=1`, { redirect: 'manual' });
    expect(unlock.status).toBe(303);
    expect(unlock.headers.get('location')).toBe('/?tab=1');
    const cookie = unlock.headers.get('set-cookie') ?? '';
    expect(cookie).toBe(`paraf_studio_${studio?.port}=secret; Path=/; HttpOnly; SameSite=Strict`);

    const headers = { cookie: `other=1; ${cookie.split(';')[0]}; flag` };
    const session = (await (await fetch(`${base}/api/session`, { headers })).json()) as {
      user: unknown;
    };
    expect(session.user).toEqual({ id: userInfo().username });
    expect((await fetch(`${base}/`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/`, { headers: { cookie: 'paraf_studio_1=secret' } })).status).toBe(
      401,
    );

    const published = await fetch(`${base}/api/flows`, {
      method: 'POST',
      headers: { ...headers, 'x-paraf-studio': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ flow: sampleFlow({ name: 'v2' }), notes: 'From the studio' }),
    });
    expect(published.status).toBe(201);
  });

  it('records the given user as publisher', async () => {
    const { base, studio } = await start({ user: { id: 'dev-7', name: 'Dev' } });
    const cookie = `paraf_studio_${studio?.port}=secret`;
    const session = (await (
      await fetch(`${base}/api/session`, { headers: { cookie } })
    ).json()) as {
      user: unknown;
    };
    expect(session.user).toEqual({ id: 'dev-7', name: 'Dev' });
  });

  it('passes repeated headers on, and accepts clients without a Host header', async () => {
    const { studio } = await start();
    const port = studio?.port as number;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/session',
          headers: { cookie: `paraf_studio_${port}=secret`, 'x-tag': ['a', 'b'] },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode as number);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
    expect(await raw(port, 'GET / HTTP/1.0\r\n\r\n')).toMatch(/^HTTP\/1\.1 401/);
  });

  it('answers 500 when a request cannot be handled', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { studio } = await start();
    const port = studio?.port as number;
    // `new Request` refuses the TRACE method.
    const response = await raw(
      port,
      `TRACE /api/session HTTP/1.1\r\nHost: localhost\r\nCookie: paraf_studio_${port}=secret\r\nConnection: close\r\n\r\n`,
    );
    expect(response).toMatch(/^HTTP\/1\.1 500/);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('uses the next port when the port is taken, and gives up after ten', async () => {
    const port = randomPort();
    const blockers = [await occupy(port)];
    const { studio } = await start({ port });
    expect(studio?.port).toBe(port + 1);
    for (let n = 2; n <= 10; n++) blockers.push(await occupy(port + n));
    await expect(start({ port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await Promise.all(blockers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  it('rethrows other listen errors', async () => {
    await expect(start({ host: 'no-such-host.invalid' })).rejects.toMatchObject({
      code: expect.stringMatching(/ENOTFOUND|EAI_AGAIN/),
    });
  });

  it('reads the port and token from the environment', async () => {
    const port = randomPort();
    vi.stubEnv('PARAF_STUDIO_PORT', String(port));
    vi.stubEnv('PARAF_STUDIO_TOKEN', 'from-env');
    const { studio } = await start({ port: undefined, token: undefined });
    expect(studio?.url).toBe(`http://localhost:${port}/?token=from-env`);
  });

  it('makes a random token and uses port 7272 by default', async () => {
    vi.stubEnv('PARAF_STUDIO_TOKEN', undefined);
    vi.stubEnv('PARAF_STUDIO_PORT', undefined);
    // Port 7272 may be in use on this machine; any port from 7272 on is fine.
    const { studio } = await start({ port: undefined, token: undefined });
    expect(studio?.port).toBeGreaterThanOrEqual(7272);
    expect(studio?.url).toMatch(/\?token=[\w-]{32}$/);
  });

  it('warns when other computers can reach it', async () => {
    const { studio, log } = await start({ host: '127.0.0.2' });
    expect(studio?.url).toMatch(/^http:\/\/127\.0\.0\.2:/);
    expect(log).toHaveBeenCalledWith(
      'Paraf Studio listens on 127.0.0.2: other computers can reach it (with the token).',
    );
  });

  it('does not start when disabled, and logs to the console by default', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const studio = await startStudio({ engine: createTestEngine(), enabled: false });
    expect(studio).toBeNull();
    expect(info).toHaveBeenCalledWith(DISABLED_MESSAGE);
    info.mockRestore();
  });

  it('reports errors when closing twice', async () => {
    const { studio } = await start();
    running.pop();
    await studio?.close();
    await expect(studio?.close()).rejects.toThrow();
  });
});
