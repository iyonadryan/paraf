import { Hono } from 'hono';
import type { Context } from 'hono';
import { basePath } from 'hono/route';
import { forbidden, resolveAuthorization } from './authorize';
import type { StudioAuthorization } from './authorize';
import { createStudioHandler, DISABLED_MESSAGE, isStudioEnabled } from './handler';
import type { StudioOptions } from './handler';

export type { StudioAuthorization } from './authorize';
export type { StudioOptions, StudioUser } from './handler';

/** Options of the Hono adapter. */
export interface HonoStudioOptions extends StudioOptions {
  /**
   * Decides who may use the studio. Return the user, `true` (allowed, anonymous), or a falsy
   * value (refused).
   */
  authorize: (c: Context) => StudioAuthorization | Promise<StudioAuthorization>;
}

/**
 * Paraf Studio as a Hono app. Mount it with `app.route`:
 *
 * @example
 * app.route('/paraf', parafStudio({ engine, authorize: (c) => isDeveloper(c) }));
 *
 * When the studio is disabled (by default when `NODE_ENV` is `production`) the app has no
 * routes.
 */
export function parafStudio(options: HonoStudioOptions): Hono {
  const app = new Hono();
  if (!isStudioEnabled(options)) {
    console.warn(DISABLED_MESSAGE);
    return app;
  }
  const handler = createStudioHandler(options);
  app.all('*', async (c) => {
    const user = resolveAuthorization(await options.authorize(c));
    if (user === false) return forbidden();
    // basePath is where the studio is mounted, e.g. "/paraf".
    const path = c.req.path.slice(basePath(c).length) || '/';
    return handler(c.req.raw, { path, user });
  });
  return app;
}
