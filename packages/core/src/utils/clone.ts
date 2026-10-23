/** Deep-copies plain data: objects, arrays, and `Date`s. Other values are copied by reference. */
export function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => clone(item)) as T;
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = clone(item);
    return copy as T;
  }
  return value;
}
