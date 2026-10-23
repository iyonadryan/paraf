import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlowNotFoundError, FlowValidationError } from '@paraf/core';
import type { ApproverTypeInfo, FlowDefinition, ParafEngine } from '@paraf/core';
import { CSRF_HEADER } from './shared';
import type { StudioUser } from './shared';

export { CSRF_HEADER } from './shared';
export type { StudioUser } from './shared';

/** Options shared by `startStudio` and the framework adapters. */
export interface StudioOptions {
  /** Your engine, with its approver types, chains, and operators registered. */
  engine: ParafEngine;
  /**
   * Where flows are published, e.g. "PRODUCTION" or "staging". Shown in the header and the
   * publish dialog; a label containing "prod" is shown in red.
   */
  label?: string;
  /** Turns the studio on or off. Default: on, unless `NODE_ENV` is `production`. */
  enabled?: boolean;
}

/** What the caller of a {@link StudioHandler} knows about the request. */
export interface StudioRequestContext {
  /** Path below the mount point, starting with `/` (e.g. `/api/flows`). */
  path: string;
  /** The authorized user, or `null` when the caller allows anonymous access. */
  user: StudioUser | null;
}

/** Serves the studio UI and its API for an already authorized request. */
export type StudioHandler = (request: Request, context: StudioRequestContext) => Promise<Response>;

const MAX_BODY_BYTES = 1_000_000;
const ACTIVE_STATUSES = ['pending', 'in_progress', 'returned'] as const;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

/** Whether the studio runs: `enabled`, or on unless `NODE_ENV` is `production`. */
export function isStudioEnabled(options: Pick<StudioOptions, 'enabled'>): boolean {
  return options.enabled ?? process.env.NODE_ENV !== 'production';
}

/** The notice logged instead of starting the studio. */
export const DISABLED_MESSAGE =
  'Paraf Studio is off because NODE_ENV is "production". Pass `enabled: true` to turn it on.';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'The request body is too large.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
  if (!isObject(body)) throw new HttpError(400, 'The request body must be a JSON object.');
  return body;
}

/** Approver types with lazily loaded options resolved, so they can be sent as JSON. */
async function serializableTypes(types: ApproverTypeInfo[]): Promise<ApproverTypeInfo[]> {
  return Promise.all(
    types.map(async (type) => {
      if (!type.configSchema) return type;
      const fields = await Promise.all(
        Object.entries(type.configSchema).map(
          async ([name, field]) =>
            [
              name,
              typeof field.options === 'function'
                ? { ...field, options: await field.options() }
                : field,
            ] as const,
        ),
      );
      return { ...type, configSchema: Object.fromEntries(fields) };
    }),
  );
}

/**
 * The studio's request handler: the UI files and a JSON API over `engine`. It does not check
 * who is calling; `startStudio` and the framework adapters do that before calling it.
 *
 * API (below the mount point): `GET api/session`, `GET api/flows`, `GET api/flows/:id`,
 * `GET api/flows/:id/versions/:version`, `POST api/flows` (publish), and
 * `POST api/flows/:id/active` (activate a version).
 */
export function createStudioHandler(options: StudioOptions & { uiDir?: string }): StudioHandler {
  const { engine } = options;
  const uiDir = normalize(options.uiDir ?? fileURLToPath(new URL('../dist/ui/', import.meta.url)));

  async function api(request: Request, path: string, user: StudioUser | null): Promise<Response> {
    const segments = path.split('/').slice(1).map(decodeURIComponent);
    const method = request.method;
    if (method !== 'GET' && request.headers.get(CSRF_HEADER) !== '1') {
      throw new HttpError(403, `Missing the ${CSRF_HEADER} header.`);
    }
    const [resource, id, sub, version] = segments;

    if (method === 'GET' && segments.length === 1 && resource === 'session') {
      return json(200, {
        label: options.label ?? null,
        user,
        approverTypes: await serializableTypes(engine.getApproverTypes()),
        chains: engine.getChains(),
        operators: engine.getOperators(),
      });
    }
    if (resource === 'flows' && segments.length === 1) {
      if (method === 'GET') return json(200, await engine.listFlows());
      if (method === 'POST') {
        const body = await readJson(request);
        if (!isObject(body.flow)) throw new HttpError(400, '"flow" must be a flow definition.');
        const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
        const published = await engine.publishFlow(body.flow as unknown as FlowDefinition, {
          ...(user ? { createdBy: user.id } : {}),
          ...(notes === '' ? {} : { notes }),
        });
        return json(201, published);
      }
    }
    if (resource === 'flows' && id !== undefined) {
      if (method === 'GET' && segments.length === 2) {
        const versions = await engine.listFlowVersions(id);
        if (versions.length === 0) throw new FlowNotFoundError(id);
        const running = await engine.findInstances({
          flowId: id,
          status: [...ACTIVE_STATUSES],
          limit: 1,
        });
        const active = await engine.getActiveFlow(id);
        return json(200, {
          id,
          activeVersion: active?.version ?? null,
          versions,
          runningInstances: running.total,
        });
      }
      if (
        method === 'GET' &&
        sub === 'versions' &&
        version !== undefined &&
        segments.length === 4
      ) {
        const flow = await engine.getFlow(id, Number(version));
        if (!flow) throw new FlowNotFoundError(id, Number(version));
        return json(200, flow);
      }
      if (method === 'POST' && sub === 'active' && segments.length === 3) {
        const body = await readJson(request);
        if (typeof body.version !== 'number')
          throw new HttpError(400, '"version" must be a number.');
        await engine.activateFlowVersion(id, body.version);
        return json(200, { activeVersion: body.version });
      }
    }
    throw new HttpError(404, 'Not found.');
  }

  async function asset(path: string): Promise<Response> {
    const file = normalize(join(uiDir, path));
    if (!file.startsWith(uiDir.endsWith(sep) ? uiDir : uiDir + sep))
      throw new HttpError(404, 'Not found.');
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      throw new HttpError(404, 'Not found.');
    }
    const isPage = path === '/index.html';
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': path.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        ...(isPage ? SECURITY_HEADERS : { 'x-content-type-options': 'nosniff' }),
      },
    });
  }

  return async (request, { path, user }) => {
    try {
      if (path.startsWith('/api/')) return await api(request, path.slice('/api'.length), user);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed.');
      }
      const url = new URL(request.url);
      // The UI uses relative URLs, so its page must end with "/".
      if (path === '/' && !url.pathname.endsWith('/')) {
        return new Response(null, {
          status: 308,
          headers: { location: `${url.pathname}/${url.search}` },
        });
      }
      return await asset(path === '/' ? '/index.html' : path);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      if (error instanceof FlowValidationError) {
        return json(422, { error: error.message, issues: error.issues });
      }
      if (error instanceof FlowNotFoundError) return json(404, { error: error.message });
      console.error('Paraf Studio: request failed.', error);
      return json(500, { error: 'Internal error; see the server log.' });
    }
  };
}
