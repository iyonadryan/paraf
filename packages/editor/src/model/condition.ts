import type { ConditionExpression } from '@paraf/core';

/** Operators the rule builder offers. */
export const COMPARISON_OPERATORS = ['==', '!=', '>', '>=', '<', '<=', 'in'] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

/** How a comparison's value is typed in the builder. */
export type ValueType = 'text' | 'number' | 'boolean' | 'list';

/** `document[field] <operator> value`. */
export interface Comparison {
  field: string;
  operator: ComparisonOperator;
  valueType: ValueType;
  value: string | number | boolean | (string | number)[];
}

/** What the builder can edit: comparisons joined by `and` / `or`. */
export interface ConditionModel {
  combinator: 'and' | 'or';
  comparisons: Comparison[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function single(value: unknown): [string, unknown] | null {
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  return entries.length === 1 ? (entries[0] as [string, unknown]) : null;
}

function valueTypeOf(value: unknown, operator: ComparisonOperator): ValueType | null {
  if (operator === 'in') {
    if (!Array.isArray(value)) return null;
    const allStrings = value.every((item) => typeof item === 'string');
    const allNumbers = value.every((item) => typeof item === 'number');
    return allStrings || allNumbers ? 'list' : null;
  }
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return null;
}

function parseComparison(expression: unknown): Comparison | null {
  const entry = single(expression);
  if (!entry) return null;
  const [operator, args] = entry;
  if (!(COMPARISON_OPERATORS as readonly string[]).includes(operator)) return null;
  if (!Array.isArray(args) || args.length !== 2) return null;
  const variable = single(args[0]);
  if (variable?.[0] !== 'var' || typeof variable[1] !== 'string') return null;
  const valueType = valueTypeOf(args[1], operator as ComparisonOperator);
  if (!valueType) return null;
  return {
    field: variable[1],
    operator: operator as ComparisonOperator,
    valueType,
    value: args[1] as Comparison['value'],
  };
}

/**
 * Turns an expression into a builder model, or `null` when the builder cannot represent it
 * exactly (it is then kept as it is). `true` is an empty model.
 */
export function parseCondition(expression: ConditionExpression | undefined): ConditionModel | null {
  if (expression === true) return { combinator: 'and', comparisons: [] };
  const comparison = parseComparison(expression);
  if (comparison) return { combinator: 'and', comparisons: [comparison] };

  const entry = single(expression);
  if (!entry || (entry[0] !== 'and' && entry[0] !== 'or') || !Array.isArray(entry[1])) return null;
  if (entry[1].length < 2) return null;
  const comparisons = entry[1].map(parseComparison);
  if (comparisons.some((item) => item === null)) return null;
  return { combinator: entry[0], comparisons: comparisons as Comparison[] };
}

/** The expression for a builder model; the inverse of {@link parseCondition}. */
export function buildCondition(model: ConditionModel): ConditionExpression {
  const expressions = model.comparisons.map((comparison): ConditionExpression => ({
    [comparison.operator]: [{ var: comparison.field }, comparison.value],
  }));
  if (expressions.length === 0) return true;
  if (expressions.length === 1) return expressions[0] as ConditionExpression;
  return { [model.combinator]: expressions };
}

/** Converts the text of a value input to the typed value. */
export function coerceValue(text: string, valueType: ValueType): Comparison['value'] {
  switch (valueType) {
    case 'number': {
      const number = Number(text);
      return text.trim() === '' || Number.isNaN(number) ? 0 : number;
    }
    case 'boolean':
      return text === 'true';
    case 'list': {
      const items = text
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
      const numeric = items.length > 0 && items.every((item) => !Number.isNaN(Number(item)));
      return numeric ? items.map(Number) : items;
    }
    default:
      return text;
  }
}

/** The text shown in a value input. */
export function valueText(value: Comparison['value']): string {
  return Array.isArray(value) ? value.join(', ') : String(value);
}
