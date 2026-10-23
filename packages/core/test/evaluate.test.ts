import { describe, expect, it, vi } from 'vitest';
import { ConditionEvaluationError, evaluateCondition } from '../src';
import type { JsonValue } from '../src';

const document = {
  amount: 15_000_000,
  departmentId: 'IT',
  submittedAt: '2026-10-01',
  urgent: false,
  tags: ['capex', 'hardware'],
  items: [{ price: 1200 }, { price: 300 }],
  owner: null,
};

const evaluate = (expression: JsonValue) => evaluateCondition(expression, document);

describe('evaluateCondition', () => {
  it.each([
    [{ '==': [{ var: 'departmentId' }, 'IT'] }, true],
    [{ '==': [{ var: 'amount' }, '15000000'] }, false],
    [{ '!=': [{ var: 'departmentId' }, 'HR'] }, true],
    [{ '==': [{ var: 'tags' }, ['capex', 'hardware']] }, true],
    [{ '==': [{ var: 'owner' }, null] }, true],
    [{ '==': [{ var: 'missing' }, null] }, true],
    [{ '>': [{ var: 'amount' }, 10_000_000] }, true],
    [{ '>=': [{ var: 'amount' }, 15_000_000] }, true],
    [{ '<': [{ var: 'items.1.price' }, 500] }, true],
    [{ '<=': [{ var: 'items.0.price' }, 1199] }, false],
    [{ '>': [{ var: 'submittedAt' }, '2026-09-30'] }, true],
    [{ '>=': [{ var: 'submittedAt' }, '2026-10-01'] }, true],
    [{ '<': [{ var: 'submittedAt' }, '2026-10-01'] }, false],
    [{ '<': [{ var: 'submittedAt' }, '2026-10-02'] }, true],
    [{ '>': [{ var: 'amount' }, '1'] }, false],
    [{ '<': [{ var: 'missing' }, 1] }, false],
    [{ in: ['capex', { var: 'tags' }] }, true],
    [{ in: [{ var: 'departmentId' }, ['HR', 'FIN']] }, false],
    [{ in: ['T', { var: 'departmentId' }] }, true],
    [{ in: ['x', 5] }, false],
    [{ and: [true, { var: 'tags' }] }, true],
    [{ and: [true, []] }, false],
    [{ or: [false, { var: 'urgent' }] }, false],
    [{ or: [0, 'yes'] }, true],
    [{ not: { var: 'urgent' } }, true],
    [{ not: [{ var: 'tags' }] }, false],
  ])('%j → %s', (expression, expected) => {
    expect(evaluate(expression as JsonValue)).toBe(expected);
  });

  it('reads paths and falls back to defaults', () => {
    expect(evaluate({ var: 'items.0.price' })).toBe(1200);
    expect(evaluate({ var: 'items.5.price' })).toBeNull();
    expect(evaluate({ var: ['missing', 7] })).toBe(7);
    expect(evaluate({ var: ['missing', { var: 'amount' }] })).toBe(15_000_000);
    expect(evaluate({ var: 'amount.value' })).toBeNull();
    expect(evaluate({ var: 'toString' })).toBeNull();
    expect(evaluate({ var: '' })).toEqual(document);
  });

  it('returns literals and arrays as they are', () => {
    expect(evaluate(5)).toBe(5);
    expect(evaluate([1, { var: 'departmentId' }])).toEqual([1, 'IT']);
    expect(evaluate({})).toEqual({});
  });

  it('calls custom operators with evaluated arguments', () => {
    const between = vi.fn((args: unknown[]) => {
      const [value, low, high] = args as number[];
      return value! >= low! && value! <= high!;
    });
    const result = evaluateCondition(
      { between: [{ var: 'items.0.price' }, 1000, 2000] },
      document,
      new Map([['between', between]]),
    );
    expect(result).toBe(true);
    expect(between).toHaveBeenCalledWith([1200, 1000, 2000], document);
  });

  it('throws on unknown operators and malformed var', () => {
    expect(() => evaluate({ nope: [] })).toThrow(ConditionEvaluationError);
    expect(() => evaluate({ var: 1 })).toThrow('"var" expects a path string');
  });
});
