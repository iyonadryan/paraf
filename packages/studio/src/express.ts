import type { Request as ExpressRequest, RequestHandler } from 'express';
import { forbidden, resolveAuthorization } from './authorize';
import type { StudioAuthorization } from './authorize';
import { createStudioHandler, DISABLED_MESSAGE, isStudioEnabled } from './handler';
import type { StudioOptions } from './handler';
import { sendResponse, toRequest } from './node';

export type { StudioAuthorization } from './authorize';
export type { StudioOptions, StudioUser } from './handler';

/** Options of the Express adapter. */
export interface ExpressStudioOptions extends StudioOptions {
  /**
   * Decides who may use the studio, e.g. `(req) => req.user?.role === 'developer' && { id:
   * req.user.id }`. Return the user, `true` (allowed, anonymous), or a falsy value (refused).
   */
  authorize: (req: ExpressRequest) => StudioAuthorization | Promise<StudioAuthorization>;
}

/**
 * Paraf Studio as Express middleware. Mount it at any path:
 *
 * @example
 * app.use('/paraf', parafStudio({ engine, authorize: (req) => req.user?.isDeveloper === true }));
 *
 * When the studio is disabled (by default when `NODE_ENV` is `production`) the middleware
 * passes every request on.
 */
export function parafStudio(options: ExpressStudioOptions): RequestHandler {
  if (!isStudioEnabled(options)) {
    console.warn(DISABLED_MESSAGE);
    return (_req, _res, next) => {
      next();
    };
  }
  const handler = createStudioHandler(options);
  return (req, res, next) => {
    void (async () => {
      const user = resolveAuthorization(await options.authorize(req));
      if (user === false) {
        await sendResponse(res, forbidden());
        return;
      }
      const url = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;
      // `express.json()` may have read the body already.
      const request = await toRequest(req, url, req.body as unknown);
      await sendResponse(res, await handler(request, { path: req.path, user }));
    })().catch(next);
  };
}
