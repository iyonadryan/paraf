/** The MySQL error number of an error thrown by `mysql2`, if any. */
export function errorNumber(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { errno?: unknown }).errno
    : undefined;
}

/** The message of an error, or `""` for thrown non-errors. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}
