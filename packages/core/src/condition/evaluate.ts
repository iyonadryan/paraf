import { ConditionEvaluationError } from '../errors';
import type { JsonObject, JsonValue } from '../types/json';

/**
 * A custom condition operator. Receives its arguments already evaluated and the document the
 * condition is evaluated against.
 */
export type OperatorFunction = (args: unknown[], document: JsonObject) => unknown;

/**
 * Truthiness used by `and`, `or`, `not`, and rule matching: like JavaScript, except that an
 * empty array is false.
 */
export function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

/** Reads a dot-separated path such as `"items.0.price"`; `undefined` when missing. */
export function readPath(data: unknown, path: string): unknown {
  if (path === '') return data;
  let current: unknown = data;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function equals(a: unknown, b: unknown): boolean {
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/** Orders two numbers or two strings; anything else is not comparable. */
function compare(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

type Builtin = (args: unknown[]) => unknown;

const ordered =
  (test: (difference: number) => boolean): Builtin =>
  ([a, b]) => {
    const difference = compare(a, b);
    return difference !== null && test(difference);
  };

const BUILTINS: Record<string, Builtin> = {
  '==': ([a, b]) => equals(a, b),
  '!=': ([a, b]) => !equals(a, b),
  '>': ordered((difference) => difference > 0),
  '>=': ordered((difference) => difference >= 0),
  '<': ordered((difference) => difference < 0),
  '<=': ordered((difference) => difference <= 0),
  in: ([needle, haystack]) => {
    if (Array.isArray(haystack)) return haystack.some((item) => equals(item, needle));
    if (typeof haystack === 'string' && typeof needle === 'string')
      return haystack.includes(needle);
    return false;
  },
  and: (args) => args.every(isTruthy),
  or: (args) => args.some(isTruthy),
  not: ([value]) => !isTruthy(value),
};

/**
 * Evaluates a JSON Logic-style expression against a document, without `eval`.
 *
 * - `==` / `!=` compare strictly (`"10"` is not equal to `10`); arrays and objects compare by
 *   content.
 * - `>`, `>=`, `<`, `<=` compare two numbers or two strings (e.g. ISO dates); any other
 *   combination is false.
 * - `in` checks array membership or a substring.
 * - `var` reads a dot-separated path; a missing path gives the default (or `null`).
 */
export function evaluateCondition(
  expression: JsonValue | undefined,
  document: JsonObject,
  operators: ReadonlyMap<string, OperatorFunction> = new Map(),
): unknown {
  const evaluate = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(evaluate);
    if (typeof node !== 'object' || node === null) return node;

    const [entry] = Object.entries(node as Record<string, unknown>);
    if (entry === undefined) return node;
    const [operator, rawArgs] = entry;
    const args: unknown[] = Array.isArray(rawArgs) ? rawArgs : [rawArgs];

    if (operator === 'var') {
      const [path, fallback] = args;
      if (typeof path !== 'string') {
        throw new ConditionEvaluationError('"var" expects a path string.');
      }
      const value = readPath(document, path);
      return value === undefined ? (evaluate(fallback) ?? null) : value;
    }
    const builtin = BUILTINS[operator];
    if (builtin) return builtin(args.map(evaluate));
    const custom = operators.get(operator);
    if (custom) return custom(args.map(evaluate), document);
    throw new ConditionEvaluationError(`Unknown condition operator "${operator}".`);
  };

  return evaluate(expression);
}
