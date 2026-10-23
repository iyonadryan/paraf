import { validateFlow } from '@paraf/core';
import type { FlowDefinition, FlowNode } from '@paraf/core';
import { defaultMessages as m } from '../src/messages';
import { buildCondition, coerceValue, parseCondition, valueText } from '../src/model/condition';
import { diffFlows } from '../src/model/diff';
import { readPathForDisplay, toText } from '../src/model/display';
import {
  addConnectedNode,
  addNode,
  connect,
  createNode,
  disconnect,
  removeNodes,
  renameNode,
  replaceNode,
  setPositions,
  uniqueNodeId,
  updateFlow,
} from '../src/model/edit';
import { edgeLabel, edgeViews, handlesOf, kindOf, mainHandle } from '../src/model/graph';
import { autoLayout, below } from '../src/model/layout';
import {
  describeApprover,
  describeChain,
  describeCondition,
  describeDuration,
  describeMode,
  describeRequire,
  describeRules,
} from '../src/model/summary';
import { applyTemplate } from '../src/model/templates';
import { specFlow } from './fixtures';

const empty = (): FlowDefinition => ({ id: 'f', name: 'F', start: '', nodes: {} });

describe('edit', () => {
  it('creates nodes with defaults', () => {
    expect(createNode('approval', 'A')).toEqual({
      type: 'approval',
      label: 'A',
      approvers: [],
      mode: 'any',
    });
    expect(createNode('approval-chain', 'C', ['supervisor'])).toEqual({
      type: 'approval-chain',
      label: 'C',
      chain: 'supervisor',
      maxLevels: 5,
    });
    expect(createNode('approval-chain', 'C')).not.toHaveProperty('chain');
    expect(createNode('condition', 'If')).toEqual({ type: 'condition', label: 'If', rules: [] });
    expect(createNode('end', 'End')).toEqual({ type: 'end', result: 'approved' });
  });

  it('adds nodes under unique IDs; the first becomes the start node', () => {
    const first = addNode(empty(), createNode('end', ''), 'end', { x: 10.4, y: 20.6 });
    expect(first.id).toBe('end_1');
    expect(first.flow.start).toBe('end_1');
    expect(first.flow.layout).toEqual({ end_1: { x: 10, y: 21 } });
    const second = addNode(first.flow, createNode('end', ''), 'end', { x: 0, y: 0 });
    expect(second.id).toBe('end_2');
    expect(second.flow.start).toBe('end_1');
    expect(uniqueNodeId(second.flow, 'end')).toBe('end_3');
  });

  it('adds a connected node, or a new start node', () => {
    const start = addConnectedNode(
      empty(),
      null,
      'next',
      createNode('approval', 'A'),
      'approval',
      below(undefined),
    );
    expect(start.flow.start).toBe('approval_1');
    const next = addConnectedNode(
      start.flow,
      'approval_1',
      'reject',
      createNode('end', ''),
      'end',
      { x: 0, y: 0 },
    );
    expect(next.flow.nodes.approval_1).toMatchObject({ onReject: 'end_1' });
  });

  it('connects and disconnects every kind of handle', () => {
    let flow = specFlow();
    flow = connect(flow, 'checkAmount', 'rule-0', 'review');
    flow = connect(flow, 'checkAmount', 'else', 'end_approved');
    flow = connect(flow, 'supervisor', 'next', 'review');
    flow = connect(flow, 'missing', 'next', 'review');
    expect(flow.nodes.checkAmount).toMatchObject({
      rules: [{ next: 'review' }],
      else: 'end_approved',
    });
    expect(flow.nodes.supervisor).toMatchObject({ next: 'review' });
    flow = disconnect(flow, 'checkAmount', 'rule-0');
    flow = disconnect(flow, 'checkAmount', 'rule-5');
    flow = disconnect(flow, 'checkAmount', 'else');
    flow = disconnect(flow, 'supervisor', 'reject');
    flow = disconnect(flow, 'missing', 'reject');
    expect(flow.nodes.checkAmount).toEqual({
      type: 'condition',
      rules: [{ when: expect.anything() }],
    });
    expect(flow.nodes.supervisor).not.toHaveProperty('onReject');
  });

  it('replaces a node without sharing objects', () => {
    const node: FlowNode = { type: 'end', result: 'rejected' };
    const flow = replaceNode(specFlow(), 'end_approved', node);
    expect(flow.nodes.end_approved).toEqual(node);
    expect(flow.nodes.end_approved).not.toBe(node);
  });

  it('removes nodes with their positions and references', () => {
    const flow = setPositions(specFlow(), { supervisor: { x: 1, y: 2 }, review: { x: 3.7, y: 4 } });
    expect(flow.layout?.review).toEqual({ x: 4, y: 4 });
    const next = removeNodes(flow, ['supervisor', 'review']);
    expect(next.start).toBe('checkAmount');
    expect(next.layout).toEqual({});
    expect(next.nodes.checkAmount).not.toHaveProperty('else');
    expect(next.nodes.chain).not.toHaveProperty('next');
    expect(removeNodes(empty(), ['x']).start).toBe('');
    const all = removeNodes(specFlow(), Object.keys(specFlow().nodes));
    expect(all.start).toBe('');
  });

  it('renames nodes and their references', () => {
    const flow = setPositions(specFlow(), { review: { x: 0, y: 0 }, chain: { x: 1, y: 1 } });
    const renamed = renameNode(flow, 'review', 'final_review');
    if (!('flow' in renamed)) throw new Error('rename failed');
    expect(renamed.flow.nodes.checkAmount).toMatchObject({ else: 'final_review' });
    expect(renamed.flow.nodes.chain).toMatchObject({ next: 'final_review' });
    expect(Object.keys(renamed.flow.layout ?? {})).toEqual(['final_review', 'chain']);
    expect(Object.keys(renamed.flow.nodes)).toContain('final_review');

    const start = renameNode(specFlow(), 'supervisor', 'boss');
    expect('flow' in start && start.flow.start).toBe('boss');
    expect('flow' in start && start.flow.layout).toBeUndefined();
    expect(renameNode(flow, 'review', 'review')).toEqual({ flow });
    expect(renameNode(flow, 'review', 'bad id')).toEqual({ error: 'invalid' });
    expect(renameNode(flow, 'review', 'chain')).toEqual({ error: 'taken' });
  });

  it('updates and removes flow fields', () => {
    const flow = updateFlow(specFlow(), { name: 'Renamed', resubmitPolicy: undefined });
    expect(flow.name).toBe('Renamed');
    expect(flow).not.toHaveProperty('resubmitPolicy');
  });
});

describe('graph', () => {
  it('classifies handles', () => {
    expect(kindOf('next')).toBe('next');
    expect(kindOf('rule-2')).toBe('rule');
    expect(mainHandle({ type: 'condition', rules: [], else: 'a' })).toBe('else');
    expect(mainHandle({ type: 'end', result: 'approved' })).toBeNull();
    expect(mainHandle(createNode('approval', ''))).toBe('next');
  });

  it('lists the handles of each node type', () => {
    const flow = specFlow();
    expect(handlesOf(flow.nodes.checkAmount as FlowNode)).toEqual([
      { id: 'else', kind: 'else', side: 'bottom', connected: true },
      { id: 'rule-0', kind: 'rule', side: 'right', connected: true },
    ]);
    expect(handlesOf(createNode('approval', ''))).toEqual([
      { id: 'next', kind: 'next', side: 'bottom', connected: false },
      { id: 'reject', kind: 'reject', side: 'right', connected: false },
    ]);
    expect(handlesOf(flow.nodes.end_approved as FlowNode)).toEqual([]);
    expect(handlesOf({ type: 'condition' } as unknown as FlowNode)).toHaveLength(1);
  });

  it('labels edges', () => {
    const condition: FlowNode = {
      type: 'condition',
      rules: [
        { label: 'Big', when: true, next: 'a' },
        { when: { '>': [{ var: 'amount' }, 5] }, next: 'a' },
        { when: { custom: [1] }, next: 'a' },
      ],
      else: 'a',
    };
    expect(edgeLabel(condition, 'rule-0', m)).toBe('Big');
    expect(edgeLabel(condition, 'rule-1', m)).toBe('amount > 5');
    expect(edgeLabel(condition, 'rule-2', m)).toBe('If #3');
    expect(edgeLabel(createNode('approval', ''), 'rule-0', m)).toBe('If #1');
    expect(edgeLabel(condition, 'else', m)).toBe('else');
    expect(edgeLabel(condition, 'reject', m)).toBe('reject');
    expect(edgeLabel(condition, 'next', m)).toBe('');
  });

  it('draws only references to existing nodes', () => {
    const flow = connect(specFlow(), 'review', 'next', 'missing');
    const edges = edgeViews(flow, m);
    expect(edges).toHaveLength(7);
    expect(edges.find((edge) => edge.id === 'checkAmount:rule-0')).toEqual({
      id: 'checkAmount:rule-0',
      source: 'checkAmount',
      sourceHandle: 'rule-0',
      target: 'chain',
      kind: 'rule',
      label: 'amount > 10,000,000',
    });
  });
});

describe('summary', () => {
  it('describes approvers, modes, rules and requirements', () => {
    expect(describeApprover({ type: 'role', value: ['finance', 'accounting'] })).toBe(
      'Role: finance, accounting',
    );
    expect(describeApprover({ type: 'supervisor', level: 2, extra: undefined })).toBe(
      'Supervisor (level 2)',
    );
    expect(describeApprover({ type: 'field', value: { path: 'a' } })).toBe('Field: {"path":"a"}');
    expect(describeApprover({ type: 'user', value: 'u1', limit: 1000 })).toBe(
      'User: u1 (limit 1,000)',
    );
    expect(describeApprover({ type: 'x', value: true })).toBe('X: true');
    expect(describeMode(undefined, m)).toBe('any 1');
    expect(describeMode('all', m)).toBe('all');
    expect(describeMode({ minimum: 2 }, m)).toBe('at least 2');
    expect(describeRules({ approvers: [{ type: 'role', value: 'manager' }], mode: 'all' }, m)).toBe(
      'Role: manager · all',
    );
    expect(describeRules({ approvers: [] }, m)).toBe('No approvers yet · any 1');
    expect(describeRules({}, m)).toBe('No approvers yet · any 1');
    expect(describeRequire(undefined, m)).toBe(m.requireAll);
    expect(describeRequire('any', m)).toBe(m.requireAny);
    expect(describeRequire({ minimum: 2 }, m)).toBe(m.requireMinimum(2));
  });

  it('describes durations', () => {
    expect(describeDuration('P3D', m)).toBe('3 days');
    expect(describeDuration('P1DT6H', m)).toBe('1 day 6 hours');
    expect(describeDuration('PT0S', m)).toBe('PT0S');
    expect(describeDuration('soon', m)).toBe('soon');
  });

  it('describes approval chains', () => {
    const chain = specFlow().nodes.chain;
    if (chain?.type !== 'approval-chain') throw new Error('fixture');
    expect(describeChain(chain, m, 'Reporting')).toEqual([
      'Reporting line · stops at role: director',
      'Max 5 levels · duplicates: auto-approve',
    ]);
    expect(describeChain({ type: 'approval-chain', chain: 'x' } as never, m, 'X')).toEqual([
      'X line',
    ]);
  });

  it('describes conditions the builder can read', () => {
    expect(
      describeCondition({
        or: [
          { '==': [{ var: 'dept' }, 'IT'] },
          { in: [{ var: 'tier' }, [1, 2]] },
          { '==': [{ var: 'urgent' }, true] },
        ],
      }),
    ).toBe('dept == "IT" or tier in [1, 2] or urgent == true');
    expect(describeCondition(true)).toBeNull();
    expect(describeCondition({ '>': [{ var: 'a' }, { var: 'b' }] })).toBeNull();
    expect(describeCondition(undefined)).toBeNull();
  });
});

describe('condition', () => {
  it('parses what the builder can edit and builds it back', () => {
    const expressions = [
      { '>': [{ var: 'amount' }, 10] },
      { and: [{ '==': [{ var: 'a' }, 'x'] }, { '!=': [{ var: 'b' }, false] }] },
      { or: [{ in: [{ var: 'c' }, ['p', 'q']] }, { '<=': [{ var: 'd' }, 3] }] },
    ];
    for (const expression of expressions) {
      const model = parseCondition(expression);
      expect(model).not.toBeNull();
      expect(buildCondition(model as NonNullable<typeof model>)).toEqual(expression);
    }
    expect(parseCondition(true)).toEqual({ combinator: 'and', comparisons: [] });
    expect(buildCondition({ combinator: 'and', comparisons: [] })).toBe(true);
    expect(parseCondition(expressions[0])?.comparisons[0]).toEqual({
      field: 'amount',
      operator: '>',
      valueType: 'number',
      value: 10,
    });
  });

  it('keeps expressions it cannot represent', () => {
    const unsupported: unknown[] = [
      undefined,
      false,
      { '>': [{ var: 'a' }, 1], '<': [{ var: 'a' }, 2] },
      { between: [{ var: 'a' }, 1] },
      { '>': [{ var: 'a' }] },
      { '>': 'a' },
      { '>': [1, 2] },
      { '>': [{ var: 3 }, 2] },
      { '>': [{ var: 'a' }, null] },
      { in: [{ var: 'a' }, 'x'] },
      { in: [{ var: 'a' }, [1, 'x']] },
      { and: [{ '>': [{ var: 'a' }, 1] }] },
      { and: { '>': [{ var: 'a' }, 1] } },
      { not: [{ '>': [{ var: 'a' }, 1] }, { '>': [{ var: 'a' }, 1] }] },
      { and: [{ '>': [{ var: 'a' }, 1] }, { not: true }] },
      ['>', 1],
    ];
    for (const expression of unsupported) expect(parseCondition(expression as never)).toBeNull();
  });

  it('converts value text', () => {
    expect(coerceValue('12', 'number')).toBe(12);
    expect(coerceValue('', 'number')).toBe(0);
    expect(coerceValue('abc', 'number')).toBe(0);
    expect(coerceValue('true', 'boolean')).toBe(true);
    expect(coerceValue('no', 'boolean')).toBe(false);
    expect(coerceValue('1, 2,', 'list')).toEqual([1, 2]);
    expect(coerceValue('a, 2', 'list')).toEqual(['a', '2']);
    expect(coerceValue('', 'list')).toEqual([]);
    expect(coerceValue('x', 'text')).toBe('x');
    expect(valueText([1, 2])).toBe('1, 2');
    expect(valueText(false)).toBe('false');
  });
});

describe('layout', () => {
  it('places nodes in rows from the start node; unreachable nodes go last', () => {
    const flow = specFlow();
    flow.nodes.orphan = { type: 'end', result: 'approved' };
    const positions = autoLayout(flow);
    expect(positions.supervisor).toEqual({ x: 40, y: 120 });
    expect(positions.checkAmount).toEqual({ x: 40, y: 310 });
    expect(positions.end_rejected).toEqual({ x: 360, y: 310 });
    expect(positions.chain?.y).toBe(500);
    expect(positions.review).toEqual({ x: 360, y: 500 });
    expect(positions.end_approved?.y).toBe(690);
    expect(positions.orphan).toEqual({ x: 40, y: 880 });
  });

  it('puts every node in the first row when there is no start node', () => {
    const positions = autoLayout({ ...empty(), nodes: { a: { type: 'end', result: 'approved' } } });
    expect(positions.a).toEqual({ x: 40, y: 120 });
    expect(below({ x: 5, y: 5 })).toEqual({ x: 5, y: 195 });
  });
});

describe('templates', () => {
  it.each(['single', 'multi', 'amount'] as const)('builds a valid %s flow', (template) => {
    const flow = applyTemplate(
      { ...empty(), nodes: { old: { type: 'end', result: 'approved' } } },
      template,
      'role',
    );
    expect(flow.id).toBe('f');
    expect(flow.nodes).not.toHaveProperty('old');
    expect(Object.keys(flow.layout ?? {}).sort()).toEqual(Object.keys(flow.nodes).sort());
    expect(validateFlow(flow, { approverTypes: ['role'] })).toEqual([]);
  });

  it('declares the amount variable', () => {
    expect(applyTemplate(empty(), 'amount', 'role').variables).toEqual([
      { key: 'amount', label: 'Amount', type: 'number', required: true },
    ]);
  });
});

describe('diff', () => {
  it('lists flow settings and nodes that changed', () => {
    const before = specFlow();
    const after = removeNodes(specFlow(), ['chain']);
    after.name = 'New name';
    after.nodes.extra = { type: 'end', label: 'Extra', result: 'approved' };
    after.nodes.late = { type: 'end', result: 'rejected' };
    after.layout = { supervisor: { x: 0, y: 0 } };
    expect(diffFlows(before, after, m)).toEqual([
      { kind: 'changed', text: 'Flow: name' },
      { kind: 'changed', text: 'checkAmount: rules' },
      { kind: 'added', text: 'Node Extra (End)' },
      { kind: 'added', text: 'Node late (End)' },
      { kind: 'removed', text: 'Node Naik sampai Direktur' },
    ]);
    expect(diffFlows(before, specFlow(), m)).toEqual([]);
  });
});

describe('display', () => {
  it('reads document paths for display', () => {
    const document = { amount: 1500000, meta: { tags: ['a'], urgent: true }, empty: null };
    expect(readPathForDisplay(document, 'amount')).toBe('1,500,000');
    expect(readPathForDisplay(document, 'meta.urgent')).toBe('true');
    expect(readPathForDisplay(document, 'meta.tags')).toBe('["a"]');
    expect(readPathForDisplay(document, 'meta.missing')).toBe('—');
    expect(readPathForDisplay(document, 'empty')).toBe('—');
    expect(readPathForDisplay(document, 'amount.deep')).toBe('—');
    expect(toText('x')).toBe('x');
    expect(toText(undefined)).toBe('');
    expect(toText({ a: 1 })).toBe('{"a":1}');
  });
});
