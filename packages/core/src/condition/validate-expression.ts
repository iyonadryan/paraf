import { BUILTIN_OPERATORS } from './operators';

/** A problem found in a condition expression. */
export interface ExpressionProblem {
  /** Location relative to the expression root, e.g. `">"[0].var`. */
  path: string;
  message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks the structure of a JSON Logic-style expression without evaluating it: every object
 * has exactly one known operator, operators get the right number of arguments, and `var`
 * receives a path (optionally followed by a default value).
 *
 * @param customOperators names of operators registered on top of the built-in ones.
 */
export function validateExpression(
  expression: unknown,
  customOperators: ReadonlySet<string> = new Set(),
): ExpressionProblem[] {
  const problems: ExpressionProblem[] = [];

  const visit = (node: unknown, path: string): void => {
    if (node === null || ['string', 'number', 'boolean'].includes(typeof node)) {
      if (typeof node === 'number' && !Number.isFinite(node)) {
        problems.push({ path, message: 'Numbers must be finite.' });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, `${path}[${index}]`);
      });
      return;
    }
    if (!isPlainObject(node)) {
      problems.push({ path, message: `Unsupported value of type ${typeof node}.` });
      return;
    }

    const entries = Object.entries(node);
    if (entries.length !== 1) {
      problems.push({
        path,
        message: `An operation must have exactly one operator key, found ${entries.length}.`,
      });
      return;
    }
    const [operator, rawArgs] = entries[0] as [string, unknown];
    const args = Array.isArray(rawArgs) ? rawArgs : [rawArgs];
    const argsPath = path === '' ? JSON.stringify(operator) : `${path}.${JSON.stringify(operator)}`;

    if (operator === 'var') {
      if (args.length < 1 || args.length > 2 || typeof args[0] !== 'string') {
        problems.push({
          path: argsPath,
          message: '"var" expects a path string, optionally followed by a default value.',
        });
        return;
      }
      if (args.length === 2) visit(args[1], `${argsPath}[1]`);
      return;
    }

    const arity = BUILTIN_OPERATORS[operator];
    if (arity === undefined && !customOperators.has(operator)) {
      problems.push({ path: argsPath, message: `Unknown operator "${operator}".` });
      return;
    }
    if (arity !== undefined) {
      const fits = typeof arity === 'number' ? args.length === arity : args.length >= arity.atLeast;
      if (!fits) {
        const expected = typeof arity === 'number' ? `${arity}` : `at least ${arity.atLeast}`;
        problems.push({
          path: argsPath,
          message: `Operator "${operator}" expects ${expected} argument(s), got ${args.length}.`,
        });
      }
    }
    args.forEach((arg, index) => {
      visit(arg, Array.isArray(rawArgs) ? `${argsPath}[${index}]` : argsPath);
    });
  };

  visit(expression, '');
  return problems;
}
