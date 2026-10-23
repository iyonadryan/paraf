import { describe, expect, it } from 'vitest';
import { DocumentValidationError, validateDocument, validateFlow } from '../src';
import type { DocumentVariable, FlowDefinition } from '../src';
import { END_NODES, setup, singleStepFlow } from './engine/helpers';
import { twoLevelFlow } from './fixtures/flows';

const variables: DocumentVariable[] = [
  { key: 'amount', label: 'Amount', type: 'number', required: true },
  { key: 'departmentId', label: 'Department', type: 'select', options: ['IT', 'HR'] },
  { key: 'neededBy', type: 'date' },
  { key: 'urgent', type: 'boolean' },
  { key: 'pic.user_id', label: 'Person in charge', type: 'user' },
  { key: 'note', type: 'text' },
];

describe('validateDocument', () => {
  it('accepts a matching document and ignores undeclared fields', () => {
    const document = {
      amount: 15_000_000,
      departmentId: 'IT',
      neededBy: '2026-10-23',
      urgent: false,
      pic: { user_id: 'u31' },
      note: 'ok',
      extra: [1, 2],
    };
    expect(validateDocument(document, variables)).toEqual([]);
    expect(validateDocument({ amount: 1, neededBy: '2026-10-23T08:00:00Z' }, variables)).toEqual(
      [],
    );
    expect(
      validateDocument({ amount: 1, neededBy: '2026-10-23 08:00:00+07:00' }, variables),
    ).toEqual([]);
  });

  it('reports missing required values and wrong types', () => {
    const problems = validateDocument(
      {
        departmentId: 'Sales',
        neededBy: '23/10/2026',
        urgent: 'yes',
        pic: { user_id: '' },
        note: 5,
      },
      variables,
    );
    expect(problems).toEqual([
      { key: 'amount', message: 'Amount (amount) is required' },
      { key: 'departmentId', message: 'Department (departmentId) must be one of "IT", "HR"' },
      { key: 'neededBy', message: 'neededBy must be an ISO 8601 date, e.g. "2026-10-23"' },
      { key: 'urgent', message: 'urgent must be true or false' },
      { key: 'pic.user_id', message: 'Person in charge (pic.user_id) must be a user ID' },
      { key: 'note', message: 'note must be text' },
    ]);
  });

  it('treats null as missing and rejects non-finite numbers and impossible dates', () => {
    expect(validateDocument({ amount: null }, variables)).toEqual([
      { key: 'amount', message: 'Amount (amount) is required' },
    ]);
    expect(validateDocument({ amount: Infinity, neededBy: '2026-13-45' }, variables)).toHaveLength(
      2,
    );
    expect(
      validateDocument({ departmentId: 'IT' }, [{ key: 'departmentId', type: 'select' }]),
    ).toEqual([{ key: 'departmentId', message: 'departmentId must be one of ' }]);
  });

  it('has nothing to check without variables', () => {
    expect(validateDocument({})).toEqual([]);
  });
});

describe('validateFlow: variables', () => {
  const withVariables = (value: unknown) => ({ ...twoLevelFlow, variables: value });

  it('accepts well-formed variables', () => {
    expect(validateFlow(withVariables(variables))).toEqual([]);
  });

  it.each([
    [{}, 'INVALID_TYPE', 'variables'],
    [['amount'], 'INVALID_TYPE', 'variables[0]'],
    [[{ type: 'number' }], 'MISSING_FIELD', 'variables[0].key'],
    [[{ key: 'total amount', type: 'number' }], 'INVALID_VARIABLE_KEY', 'variables[0].key'],
    [[{ key: 'a.', type: 'number' }], 'INVALID_VARIABLE_KEY', 'variables[0].key'],
    [[{ key: 'a' }], 'MISSING_FIELD', 'variables[0].type'],
    [[{ key: 'a', type: 'money' }], 'INVALID_VALUE', 'variables[0].type'],
    [[{ key: 'a', type: 'number', required: 'yes' }], 'INVALID_TYPE', 'variables[0].required'],
    [[{ key: 'a', type: 'number', label: 1 }], 'INVALID_TYPE', 'variables[0].label'],
    [[{ key: 'a', type: 'number', unit: 'IDR' }], 'UNKNOWN_FIELD', 'variables[0].unit'],
    [[{ key: 'a', type: 'select' }], 'INVALID_OPTIONS', 'variables[0].options'],
    [[{ key: 'a', type: 'select', options: [] }], 'INVALID_OPTIONS', 'variables[0].options'],
    [
      [{ key: 'a', type: 'select', options: ['x', 'x'] }],
      'INVALID_OPTIONS',
      'variables[0].options',
    ],
    [[{ key: 'a', type: 'select', options: [''] }], 'INVALID_OPTIONS', 'variables[0].options'],
    [[{ key: 'a', type: 'text', options: ['x'] }], 'INVALID_OPTIONS', 'variables[0].options'],
    [
      [
        { key: 'a', type: 'text' },
        { key: 'a', type: 'number' },
      ],
      'DUPLICATE_VARIABLE',
      'variables[1].key',
    ],
  ])('rejects %j', (value, code, path) => {
    expect(validateFlow(withVariables(value))).toEqual([expect.objectContaining({ code, path })]);
  });
});

describe('engine: document variables', () => {
  const flow = {
    ...singleStepFlow({ approvers: [{ type: 'role', value: 'manager' }], mode: 'any' }, 'vars'),
    variables: [
      { key: 'amount', type: 'number', required: true },
      { key: 'departmentId', type: 'select', options: ['IT', 'HR'] },
    ],
  } as FlowDefinition;

  it('rejects starting with an invalid document, before anything is stored', async () => {
    const t = setup();
    await t.publish(flow);
    const error = await t.engine
      .start('vars', {
        subject: { type: 'doc', id: '1' },
        requester: { id: 'u7' },
        document: { departmentId: 'Sales' },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DocumentValidationError);
    expect(error).toMatchObject({
      code: 'DOCUMENT_INVALID',
      problems: [{ key: 'amount' }, { key: 'departmentId' }],
      context: { action: 'start', userId: 'u7' },
    });
    expect((await t.engine.findInstances({})).total).toBe(0);
  });

  it('starts with a valid document', async () => {
    const t = setup();
    const instance = await t.run(flow, { document: { amount: 5, departmentId: 'IT' } });
    expect(instance.status).toBe('pending');
  });

  it('checks the new document on resubmit', async () => {
    const t = setup();
    const instance = await t.run(flow, { document: { amount: 5 } });
    await t.engine.returnForRevision(instance.id, 'm1', 'fix');
    await expect(t.engine.resubmit(instance.id, 'u7', { amount: 'five' })).rejects.toThrow(
      DocumentValidationError,
    );
    expect((await t.state(instance.id)).instance).toMatchObject({ status: 'returned', round: 1 });
    expect((await t.engine.resubmit(instance.id, 'u7', { amount: 6 })).document).toEqual({
      amount: 6,
    });
  });

  it('is unaffected when the flow declares no variables', async () => {
    const t = setup();
    const plain = {
      id: 'plain',
      name: 'Plain',
      start: 'approved',
      nodes: { approved: END_NODES.approved },
    } as FlowDefinition;
    expect((await t.run(plain, { document: { anything: true } })).status).toBe('approved');
  });
});
