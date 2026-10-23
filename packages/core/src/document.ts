import { readPath } from './condition/evaluate';
import type { DocumentVariable } from './types/flow';
import type { JsonObject } from './types/json';

/** One document value that does not match its variable. */
export interface DocumentProblem {
  key: string;
  message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

function typeProblem(variable: DocumentVariable, value: unknown): string | null {
  switch (variable.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'select':
      return typeof value === 'string' && (variable.options ?? []).includes(value)
        ? null
        : `must be one of ${(variable.options ?? []).map((o) => `"${o}"`).join(', ')}`;
    case 'date':
      return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))
        ? null
        : 'must be an ISO 8601 date, e.g. "2026-10-23"';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'user':
      return typeof value === 'string' && value !== '' ? null : 'must be a user ID';
    default:
      return typeof value === 'string' ? null : 'must be text';
  }
}

/**
 * Checks a document against a flow's variables: required values are present and every
 * present value has the declared type. Fields that are not declared are not checked.
 */
export function validateDocument(
  document: JsonObject,
  variables: readonly DocumentVariable[] = [],
): DocumentProblem[] {
  const problems: DocumentProblem[] = [];
  for (const variable of variables) {
    const value = readPath(document, variable.key);
    const name = variable.label ? `${variable.label} (${variable.key})` : variable.key;
    if (value === undefined || value === null) {
      if (variable.required) problems.push({ key: variable.key, message: `${name} is required` });
      continue;
    }
    const problem = typeProblem(variable, value);
    if (problem) problems.push({ key: variable.key, message: `${name} ${problem}` });
  }
  return problems;
}
