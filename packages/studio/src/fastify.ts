import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, resolveAuthorization } from './authorize';
import type { StudioAuthorization } from './authorize';
import { createStudioHandler, DISABLED_MESSAGE, isStudioEnabled } from './handler';
import type { StudioOptions } from './handler';

export type { StudioAuthorization } from './authorize';
export type { StudioOptions, StudioUser } from './handler';

/** Options of the Fastify adapter. */
export interface FastifyStudioOptions extends StudioOptions {
  /**
   * Decides who may use the studio. Return the user, `true` (allowed, anonymous), or a falsy
   * value (refused).
   */
  authorize: (request: FastifyRequest) => StudioAuthorization | Promise<StudioAuthorization>;
}

async function send(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  reply.status(response.status);
  response.headers.forEach((value, name) => {
    reply.header(name, value);
  });
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

/**
 * Paraf Studio as a Fastify plugin. Register it with a prefix:
 *
 * @example
 * await app.register(parafStudio({ engine, authorize: (request) => isDeveloper(request) }), {
 *   prefix: '/paraf',
 * });
 *
 * When the studio is disabled (by default when `NODE_ENV` is `production`) the plugin adds no
 * routes.
 */
export function parafStudio(options: FastifyStudioOptions): FastifyPluginAsync {
  return (app) => {
    if (!isStudioEnabled(options)) {
      console.warn(DISABLED_MESSAGE);
      return Promise.resolve();
    }
    const handler = createStudioHandler(options);
    // Inside this plugin only: hand request bodies to the studio unparsed.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
    const handle = async (request: FastifyRequest, reply: FastifyReply) => {
      const user = resolveAuthorization(await options.authorize(request));
      if (user === false) return send(reply, forbidden());
      const url = `${request.protocol}://${request.host}${request.url}`;
      const body = request.body as Buffer | undefined;
      const init: RequestInit = {
        method: request.method,
        headers: request.headers as Record<string, string>,
      };
      if (body !== undefined && request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = new Uint8Array(body);
      }
      const path = `/${(request.params as { '*'?: string })['*'] ?? ''}`;
      return send(reply, await handler(new Request(url, init), { path, user }));
    };
    app.all('/', handle);
    app.all('/*', handle);
    return Promise.resolve();
  };
}
