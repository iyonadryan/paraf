import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { userInfo } from 'node:os';
import { createStudioHandler, DISABLED_MESSAGE, isStudioEnabled } from './handler';
import type { StudioOptions, StudioUser } from './handler';

/** Default port of {@link startStudio}: "PARA" on a phone keypad. */
export const DEFAULT_STUDIO_PORT = 7272;

/** How many following ports `startStudio` tries when the port is taken. */
const PORT_ATTEMPTS = 10;

/** Hosts only this computer can reach. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
/** Hosts shown as "localhost" in the printed link. */
const SHOWN_AS_LOCALHOST = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);

/** Options of {@link startStudio}. */
export interface StartStudioOptions extends StudioOptions {
  /**
   * Port to listen on. Default: `PARAF_STUDIO_PORT`, else 7272. When it is taken, the next
   * free port (up to 10 further) is used.
   */
  port?: number;
  /** Interface to listen on. Default `127.0.0.1`: only this computer can connect. */
  host?: string;
  /**
   * Secret in the link that opens the studio. Default: `PARAF_STUDIO_TOKEN`, else a random token
   * printed when the studio starts.
   */
  token?: string;
  /** Recorded as the publisher of new versions. Default: your operating-system user name. */
  user?: StudioUser;
  /** Where the start-up message goes. Default `console.log`. */
  log?: (message: string) => void;
}

/** A studio started by {@link startStudio}. */
export interface RunningStudio {
  /** The link to open, including the token. */
  url: string;
  port: number;
  /** Stops the server. */
  close: () => Promise<void>;
}

/**
 * The URL and headers of a Node request as a standard `Request`. `body` is used when a
 * framework already read the body (e.g. `express.json()`); otherwise the stream is read.
 */
export async function toRequest(
  req: IncomingMessage,
  url: string,
  body?: unknown,
): Promise<Request> {
  const headers = new Headers();
  for (const [name, values] of Object.entries(req.headersDistinct)) {
    for (const value of values as string[]) headers.append(name, value);
  }
  const method = req.method as string;
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers });
  let data: Uint8Array;
  if (body === undefined) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    data = Buffer.concat(chunks);
  } else if (Buffer.isBuffer(body)) {
    data = body;
  } else {
    data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  }
  return new Request(url, { method, headers, body: new Uint8Array(data) });
}

/** Writes a standard `Response` (from the studio handler, which sets no cookies) to Node. */
export async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}

function cookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

function sameSecret(given: string | null, secret: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOCKED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Paraf Studio</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px/1.5 system-ui,sans-serif;color:#1a1d23;background:#f4f5f7;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:420px;background:#fff;border:1px solid #dde1e7;border-radius:10px;padding:24px}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#3d4450}</style>
</head><body><main><h1>Paraf Studio is locked</h1>
<p>Open the link printed in the terminal where the studio started. It contains a token that unlocks the studio in this browser.</p>
</main></body></html>`;

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as { port: number }).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Starts Paraf Studio on its own port: the flow editor and version history for `engine`, which
 * publishes to the database your engine uses. It listens on 127.0.0.1 only and is opened with
 * a link containing a secret token. Returns `null` (and starts nothing) when the studio is
 * disabled, which by default it is when `NODE_ENV` is `production`.
 *
 * @example
 * if (process.env.NODE_ENV !== 'production') {
 *   await startStudio({ engine, label: 'development' });
 * }
 */
export async function startStudio(options: StartStudioOptions): Promise<RunningStudio | null> {
  const log = options.log ?? console.log;
  if (!isStudioEnabled(options)) {
    log(DISABLED_MESSAGE);
    return null;
  }
  const envPort = process.env.PARAF_STUDIO_PORT;
  const firstPort = options.port ?? (envPort ? Number(envPort) : DEFAULT_STUDIO_PORT);
  const host = options.host ?? '127.0.0.1';
  const token =
    options.token ?? process.env.PARAF_STUDIO_TOKEN ?? randomBytes(24).toString('base64url');
  const user = options.user ?? { id: userInfo().username };
  const handler = createStudioHandler(options);
  let cookieName = 'paraf_studio';

  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    // HTTP/1.0 clients may omit Host.
    const url = new URL(req.url as string, `http://${req.headers.host ?? 'localhost'}`);
    const given = url.searchParams.get('token');
    if (given !== null && sameSecret(given, token)) {
      url.searchParams.delete('token');
      res.writeHead(303, {
        location: `${url.pathname}${url.search}`,
        'set-cookie': `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`,
      });
      res.end();
      return;
    }
    if (!sameSecret(cookie(req.headers.cookie, cookieName), token)) {
      const api = url.pathname.startsWith('/api/');
      res.writeHead(401, {
        'content-type': api ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
      });
      res.end(
        api ? JSON.stringify({ error: 'Open the link printed in the terminal.' }) : LOCKED_PAGE,
      );
      return;
    }
    const request = await toRequest(req, url.href);
    await sendResponse(res, await handler(request, { path: url.pathname, user }));
  };

  const server = createServer((req, res) => {
    serve(req, res).catch((error: unknown) => {
      console.error('Paraf Studio: request failed.', error);
      res.statusCode = 500;
      res.end();
    });
  });

  let port: number;
  for (let attempt = 0; ; attempt++) {
    try {
      port = await listen(server, firstPort === 0 ? 0 : firstPort + attempt, host);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || attempt + 1 >= PORT_ATTEMPTS) throw error;
    }
  }
  // Cookies are shared between ports of a host, so each studio port has its own cookie.
  cookieName = `paraf_studio_${port}`;

  const shownHost = SHOWN_AS_LOCALHOST.has(host) ? 'localhost' : host;
  const url = `http://${shownHost}:${port}/?token=${token}`;
  log(`Paraf Studio: ${url}${options.label ? `  (publishes to: ${options.label})` : ''}`);
  if (!LOOPBACK_HOSTS.has(host)) {
    log(`Paraf Studio listens on ${host}: other computers can reach it (with the token).`);
  }
  return {
    url,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}
