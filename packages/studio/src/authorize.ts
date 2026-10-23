import type { StudioUser } from './handler';

/**
 * What an `authorize` function returns: the user (recorded as the publisher), `true` to allow
 * without a name, or `false` / `null` / `undefined` to refuse.
 */
export type StudioAuthorization = StudioUser | boolean | null | undefined;

/** The user to pass on, `null` for anonymous access, or `false` when access is refused. */
export function resolveAuthorization(result: StudioAuthorization): StudioUser | null | false {
  if (result === true) return null;
  if (result === false || result === null || result === undefined) return false;
  return result;
}

/** The response for a refused request. */
export function forbidden(): Response {
  return new Response(JSON.stringify({ error: 'You are not allowed to use Paraf Studio.' }), {
    status: 403,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
