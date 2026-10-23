/** Exact number of arguments, or `{ atLeast: n }` for variadic operators. */
export type OperatorArity = number | { atLeast: number };

/** Arity of the built-in condition operators. `var` is handled separately. */
export const BUILTIN_OPERATORS: Readonly<Record<string, OperatorArity>> = {
  '==': 2,
  '!=': 2,
  '>': 2,
  '>=': 2,
  '<': 2,
  '<=': 2,
  in: 2,
  and: { atLeast: 1 },
  or: { atLeast: 1 },
  not: 1,
};
