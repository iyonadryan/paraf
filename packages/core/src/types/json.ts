/** A JSON primitive value. */
export type JsonPrimitive = string | number | boolean | null;

/** Any value that survives a `JSON.stringify` / `JSON.parse` round-trip. */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

/**
 * A JSON object. `undefined` properties are allowed and treated as absent (as
 * `JSON.stringify` does), so arrays of differently shaped object literals type-check.
 */
export type JsonObject = { [key: string]: JsonValue | undefined };
