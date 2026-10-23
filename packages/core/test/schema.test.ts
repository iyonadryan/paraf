import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { flowSchema } from '../src';
import { twoLevelFlow, validFlows } from './fixtures/flows';

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validate = ajv.compile(flowSchema);

function withNode(node: Record<string, unknown>, root: Record<string, unknown> = {}): unknown {
  return { ...twoLevelFlow, ...root, nodes: { ...twoLevelFlow.nodes, director: node } };
}

const director = twoLevelFlow.nodes.director;

describe('flowSchema', () => {
  it('compiles in strict mode', () => {
    expect(validate).toBeTypeOf('function');
  });

  it.each(Object.entries(validFlows))('accepts %s', (_name, flow) => {
    expect(validate(flow), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    [
      'both approvers and groups',
      withNode({ ...director, groups: [{ id: 'g', approvers: director.approvers, mode: 'any' }] }),
    ],
    [
      'neither approvers nor groups',
      withNode({ type: 'approval', mode: 'any', next: 'approved', onReject: 'rejected' }),
    ],
    ['missing mode', withNode({ ...director, mode: undefined })],
    ['minimum 0', withNode({ ...director, mode: { minimum: 0 } })],
    ['unknown node field', withNode({ ...director, onreject: 'rejected' })],
    ['unknown root field', { ...twoLevelFlow, owner: 'me' }],
    [
      'bad duration',
      withNode({
        ...director,
        timeout: { after: '3 days', action: 'escalate', to: director.approvers },
      }),
    ],
    [
      'bad node id',
      {
        ...twoLevelFlow,
        nodes: { ...twoLevelFlow.nodes, 'bad id': { type: 'end', result: 'approved' } },
      },
    ],
    ['user approver without value', withNode({ ...director, approvers: [{ type: 'user' }] })],
    [
      'user approver with extra keys',
      withNode({ ...director, approvers: [{ type: 'user', value: 'u1', level: 1 }] }),
    ],
    [
      'field approver with array',
      withNode({ ...director, approvers: [{ type: 'field', value: ['a'] }] }),
    ],
    ['unknown node type', withNode({ type: 'parallel' })],
    [
      'chain without maxLevels',
      withNode({
        type: 'approval-chain',
        chain: 'supervisor',
        next: 'approved',
        onReject: 'rejected',
      }),
    ],
    [
      'condition without else',
      withNode({ type: 'condition', rules: [{ when: true, next: 'approved' }] }),
    ],
    ['end with unknown result', withNode({ type: 'end', result: 'done' })],
  ])('rejects %s', (_name, flow) => {
    expect(validate(JSON.parse(JSON.stringify(flow)))).toBe(false);
  });
});
