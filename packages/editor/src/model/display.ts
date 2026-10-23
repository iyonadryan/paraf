/** A document value at a dot-separated path, formatted for display (`—` when missing). */
export function readPathForDisplay(document: unknown, path: string): string {
  let current: unknown = document;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return '—';
    current = (current as Record<string, unknown>)[key];
  }
  if (current === undefined || current === null) return '—';
  if (typeof current === 'number') return current.toLocaleString('en-US');
  return toText(current);
}

/** A value as plain text: scalars as they are, anything else as JSON. */
export function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === undefined ? '' : JSON.stringify(value);
}
