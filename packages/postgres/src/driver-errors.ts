/** Reads a property of an error thrown by `pg` (`code`, `constraint`, ...), if any. */
export function errorField(error: unknown, field: 'code' | 'constraint'): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;
}
