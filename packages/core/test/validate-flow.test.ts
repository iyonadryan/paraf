import { describe, expect, it } from 'vitest';
import { validateFlow } from '../src';
import type { FlowDefinition, FlowValidationIssue, ValidateFlowOptions } from '../src';
import {
  kitchenSinkFlow,
  purchaseRequestFlow,
  registries,
  twoLevelFlow,
  validFlows,
} from './fixtures/flows';

/** A mutable deep copy of a fixture, to break in a test. */
function draft(source: FlowDefinition = twoLevelFlow): any {
  return JSON.parse(JSON.stringify(source));
}

function codes(flow: unknown, options?: ValidateFlowOptions): string[] {
  return validateFlow(flow, options).map((issue) => issue.code);
}

function expectIssue(
  flow: unknown,
  expected: Partial<FlowValidationIssue>,
  options?: ValidateFlowOptions,
): void {
  expect(validateFlow(flow, options)).toContainEqual(expect.objectContaining(expected));
}

/** A valid single-node approval flow for testing approval node rules. */
function approvalFlow(node: Record<string, unknown>): any {
  return {
    id: 'f',
    name: 'F',
    start: 'a',
    nodes: {
      a: { type: 'approval', next: 'ok', onReject: 'no', ...node },
      ok: { type: 'end', result: 'approved' },
      no: { type: 'end', result: 'rejected' },
    },
  };
}

function chainFlow(node: Record<string, unknown>): any {
  return {
    id: 'f',
    name: 'F',
    start: 'c',
    nodes: {
      c: {
        type: 'approval-chain',
        chain: 'supervisor',
        maxLevels: 3,
        next: 'ok',
        onReject: 'no',
        ...node,
      },
      ok: { type: 'end', result: 'approved' },
      no: { type: 'end', result: 'rejected' },
    },
  };
}

function conditionFlow(when: unknown, operators?: string[]): FlowValidationIssue[] {
  const flow = {
    id: 'f',
    name: 'F',
    start: 'cond',
    nodes: {
      cond: { type: 'condition', rules: [{ when, next: 'ok' }], else: 'ok' },
      ok: { type: 'end', result: 'approved' },
    },
  };
  return validateFlow(flow, operators ? { operators } : {});
}

const role = (value: string) => ({ type: 'role', value });

describe('validateFlow: valid flows', () => {
  it.each(Object.entries(validFlows))('accepts %s', (_name, flow) => {
    expect(validateFlow(flow)).toEqual([]);
    expect(validateFlow(flow, registries)).toEqual([]);
  });

  it('accepts a flow without version (assigned on publish)', () => {
    const flow = draft();
    delete flow.version;
    expect(validateFlow(flow)).toEqual([]);
  });
});

describe('validateFlow: flow fields', () => {
  it.each([null, [], 'flow', 42])('rejects a non-object flow (%j)', (value) => {
    expect(codes(value)).toEqual(['INVALID_TYPE']);
  });

  it('reports unknown root fields', () => {
    const flow = draft();
    flow.nmae = 'typo';
    expectIssue(flow, { code: 'UNKNOWN_FIELD', path: 'nmae' });
  });

  it('requires id, name, start, and nodes', () => {
    const issues = validateFlow({});
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual(
      expect.arrayContaining([
        ['MISSING_FIELD', 'id'],
        ['MISSING_FIELD', 'name'],
        ['MISSING_FIELD', 'nodes'],
      ]),
    );
  });

  it.each(['purchase request', '-leading-dash', 'a'.repeat(101), 'PR/2026'])(
    'rejects flow id %j',
    (id) => {
      const flow = draft();
      flow.id = id;
      expect(codes(flow)).toEqual(['INVALID_ID']);
    },
  );

  it('rejects a non-string id and an empty name', () => {
    const flow = draft();
    flow.id = 7;
    flow.name = '';
    expect(codes(flow)).toEqual(['INVALID_TYPE', 'INVALID_VALUE']);
  });

  it.each([0, -1, 1.5, '1'])('rejects version %j', (version) => {
    const flow = draft();
    flow.version = version;
    expectIssue(flow, { code: 'INVALID_VALUE', path: 'version' });
  });

  it('rejects an unknown resubmitPolicy', () => {
    const flow = draft();
    flow.resubmitPolicy = 'again';
    expectIssue(flow, { code: 'INVALID_VALUE', path: 'resubmitPolicy' });
  });

  it('rejects nodes that are not an object, and empty nodes', () => {
    expectIssue({ ...draft(), nodes: [] }, { code: 'INVALID_TYPE', path: 'nodes' });
    expectIssue({ ...draft(), nodes: {} }, { code: 'EMPTY_NODES', path: 'nodes' });
  });
});

describe('validateFlow: nodes', () => {
  it('rejects an invalid node id', () => {
    const flow = draft();
    flow.nodes['bad id'] = { type: 'end', result: 'approved' };
    expectIssue(flow, { code: 'INVALID_ID', nodeId: 'bad id' });
  });

  it('rejects a node that is not an object', () => {
    const flow = draft();
    flow.nodes.director = 'oops';
    expectIssue(flow, { code: 'INVALID_TYPE', nodeId: 'director', path: 'nodes.director' });
  });

  it('requires a node type and rejects unknown types', () => {
    const flow = draft();
    delete flow.nodes.director.type;
    flow.nodes.approved.type = 'finish';
    expectIssue(flow, { code: 'MISSING_FIELD', nodeId: 'director', path: 'nodes.director.type' });
    expectIssue(flow, { code: 'UNKNOWN_NODE_TYPE', nodeId: 'approved' });
  });

  it('rejects a non-string label', () => {
    const flow = draft();
    flow.nodes.director.label = 5;
    expectIssue(flow, { code: 'INVALID_TYPE', path: 'nodes.director.label' });
  });

  it('reports unknown node fields (typos)', () => {
    const flow = draft();
    flow.nodes.director.onreject = 'rejected';
    expectIssue(flow, {
      code: 'UNKNOWN_FIELD',
      nodeId: 'director',
      path: 'nodes.director.onreject',
    });
  });

  it('validates end nodes', () => {
    const flow = draft();
    delete flow.nodes.approved.result;
    flow.nodes.rejected.result = 'done';
    expectIssue(flow, { code: 'MISSING_FIELD', nodeId: 'approved' });
    expectIssue(flow, { code: 'INVALID_VALUE', nodeId: 'rejected' });
  });
});

describe('validateFlow: graph', () => {
  it('requires start to reference an existing node', () => {
    const flow = draft();
    flow.start = 'nowhere';
    expectIssue(flow, { code: 'UNKNOWN_NODE_REFERENCE', path: 'start' });
  });

  it('rejects a non-string start', () => {
    const flow = draft();
    flow.start = 1;
    expectIssue(flow, { code: 'INVALID_TYPE', path: 'start' });
  });

  it('requires start', () => {
    const flow = draft();
    delete flow.start;
    expectIssue(flow, { code: 'MISSING_FIELD', path: 'start' });
  });

  it.each([
    ['next', (flow: any) => (flow.nodes.supervisor.next = 'ghost'), 'nodes.supervisor.next'],
    [
      'onReject',
      (flow: any) => (flow.nodes.supervisor.onReject = 'ghost'),
      'nodes.supervisor.onReject',
    ],
    ['else', (flow: any) => (flow.nodes.checkAmount.else = 'ghost'), 'nodes.checkAmount.else'],
    [
      'rule next',
      (flow: any) => (flow.nodes.checkAmount.rules[0].next = 'ghost'),
      'nodes.checkAmount.rules[0].next',
    ],
    ['chain next', (flow: any) => (flow.nodes.chain.next = 'ghost'), 'nodes.chain.next'],
  ])('reports unknown %s references', (_name, mutate, path) => {
    const flow = draft(purchaseRequestFlow);
    mutate(flow);
    expectIssue(flow, { code: 'UNKNOWN_NODE_REFERENCE', path });
  });

  it('rejects a non-string reference', () => {
    const flow = draft();
    flow.nodes.supervisor.next = ['director'];
    expectIssue(flow, { code: 'INVALID_TYPE', path: 'nodes.supervisor.next' });
  });

  it('requires at least one end node', () => {
    const flow = approvalFlow({ approvers: [role('x')], mode: 'any' });
    flow.nodes.ok = {
      type: 'approval',
      approvers: [role('y')],
      mode: 'any',
      next: 'a',
      onReject: 'a',
    };
    flow.nodes.no = {
      type: 'approval',
      approvers: [role('y')],
      mode: 'any',
      next: 'a',
      onReject: 'a',
    };
    expect(codes(flow)).toContain('NO_END_NODE');
  });

  it('reports nodes unreachable from start', () => {
    const flow = draft();
    flow.nodes.orphan = { type: 'end', result: 'approved' };
    expect(validateFlow(flow)).toEqual([
      expect.objectContaining({ code: 'UNREACHABLE_NODE', nodeId: 'orphan' }),
    ]);
  });

  it.each(['next', 'onReject'])('reports an approval node without %s as a dead end', (field) => {
    const flow = draft();
    Reflect.deleteProperty(flow.nodes.director, field);
    expectIssue(flow, { code: 'DEAD_END', nodeId: 'director', path: `nodes.director.${field}` });
  });

  it.each(['next', 'onReject'])(
    'reports an approval-chain node without %s as a dead end',
    (field) => {
      const flow = chainFlow({});
      Reflect.deleteProperty(flow.nodes.c, field);
      expectIssue(flow, { code: 'DEAD_END', nodeId: 'c' });
    },
  );

  it('reports a rule without next as a dead end', () => {
    const flow = draft(purchaseRequestFlow);
    delete flow.nodes.checkAmount.rules[0].next;
    expectIssue(flow, { code: 'DEAD_END', path: 'nodes.checkAmount.rules[0].next' });
  });

  it('detects a loop through next', () => {
    const flow = draft();
    flow.nodes.director.next = 'supervisor';
    const cycles = validateFlow(flow).filter((issue) => issue.code === 'CYCLE');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toContain('supervisor → director → supervisor');
  });

  it('detects a node pointing to itself', () => {
    const flow = draft();
    flow.nodes.director.onReject = 'director';
    expectIssue(flow, { code: 'CYCLE', nodeId: 'director' });
  });

  it('detects a loop through a condition branch', () => {
    const flow = draft(purchaseRequestFlow);
    flow.nodes.review.next = 'checkAmount';
    const cycle = validateFlow(flow).find((issue) => issue.code === 'CYCLE');
    expect(cycle?.message).toContain('checkAmount → chain → review → checkAmount');
  });

  it('detects loops in parts of the graph that are unreachable', () => {
    const flow = draft();
    flow.nodes.x = {
      type: 'approval',
      approvers: [role('a')],
      mode: 'any',
      next: 'y',
      onReject: 'no',
    };
    flow.nodes.y = {
      type: 'approval',
      approvers: [role('a')],
      mode: 'any',
      next: 'x',
      onReject: 'no',
    };
    flow.nodes.no = { type: 'end', result: 'rejected' };
    expect(codes(flow)).toContain('CYCLE');
  });
});

describe('validateFlow: condition nodes', () => {
  it('requires else', () => {
    const flow = draft(purchaseRequestFlow);
    delete flow.nodes.checkAmount.else;
    expectIssue(flow, { code: 'CONDITION_MISSING_ELSE', nodeId: 'checkAmount' });
  });

  it('requires at least one rule', () => {
    const flow = draft(purchaseRequestFlow);
    flow.nodes.checkAmount.rules = [];
    expectIssue(flow, { code: 'EMPTY_RULES', nodeId: 'checkAmount' });
    delete flow.nodes.checkAmount.rules;
    expectIssue(flow, { code: 'EMPTY_RULES', nodeId: 'checkAmount' });
  });

  it('rejects malformed rules', () => {
    const flow = draft(purchaseRequestFlow);
    flow.nodes.checkAmount.rules = 'amount > 10';
    expectIssue(flow, { code: 'INVALID_TYPE', path: 'nodes.checkAmount.rules' });
    flow.nodes.checkAmount.rules = [42, { next: 'chain', label: 1, extra: true }];
    expectIssue(flow, { code: 'INVALID_TYPE', path: 'nodes.checkAmount.rules[0]' });
    expectIssue(flow, { code: 'MISSING_FIELD', path: 'nodes.checkAmount.rules[1].when' });
    expectIssue(flow, { code: 'INVALID_TYPE', path: 'nodes.checkAmount.rules[1].label' });
    expectIssue(flow, { code: 'UNKNOWN_FIELD', path: 'nodes.checkAmount.rules[1].extra' });
  });

  it.each([
    ['literal true', true],
    ['null', null],
    ['var with default', { '==': [{ var: ['status', 'draft'] }, 'draft'] }],
    ['single-argument not', { not: { var: 'urgent' } }],
    ['nested and/or', { and: [{ or: [true, false] }, { in: ['a', ['a', 'b']] }] }],
  ])('accepts %s', (_name, when) => {
    expect(conditionFlow(when)).toEqual([]);
  });

  it.each([
    ['unknown operator', { between: [1, 2, 3] }, 'Unknown operator "between"'],
    ['multiple operator keys', { '>': [1, 2], '<': [1, 2] }, 'exactly one operator key'],
    ['empty object', {}, 'exactly one operator key'],
    ['comparison with one argument', { '>': [{ var: 'amount' }] }, 'expects 2 argument(s), got 1'],
    ['not with two arguments', { not: [true, false] }, 'expects 1 argument(s), got 2'],
    ['and without arguments', { and: [] }, 'expects at least 1 argument(s), got 0'],
    ['var with a number', { var: 5 }, '"var" expects a path string'],
    ['var with too many arguments', { var: ['a', 1, 2] }, '"var" expects a path string'],
    ['non-finite number', { '>': [{ var: 'a' }, Infinity] }, 'finite'],
    ['unsupported value', { '==': [{ var: 'a' }, () => 1] }, 'Unsupported value'],
  ])('rejects %s', (_name, when, message) => {
    const issues = conditionFlow(when);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'INVALID_CONDITION', nodeId: 'cond' });
    expect(issues[0]?.message).toContain(message);
  });

  it('points at nested problems', () => {
    const [issue] = conditionFlow({ and: [true, { '>': [{ var: 1 }, 2] }] });
    expect(issue?.path).toBe('nodes.cond.rules[0].when."and"[1].">"[0]."var"');
  });

  it('checks the default value of var', () => {
    expect(conditionFlow({ var: ['a', { nope: [] }] })[0]?.message).toContain(
      'Unknown operator "nope"',
    );
  });

  it('accepts registered custom operators', () => {
    const when = { startsWith: [{ var: 'code' }, 'PR'] };
    expect(conditionFlow(when)[0]?.code).toBe('INVALID_CONDITION');
    expect(conditionFlow(when, ['startsWith'])).toEqual([]);
  });
});

describe('validateFlow: approval nodes', () => {
  it('rejects approvers and groups together', () => {
    const flow = approvalFlow({
      approvers: [role('x')],
      mode: 'any',
      groups: [{ id: 'g', approvers: [role('y')], mode: 'any' }],
    });
    expectIssue(flow, { code: 'APPROVERS_AND_GROUPS', nodeId: 'a' });
  });

  it('requires approvers or groups', () => {
    expect(codes(approvalFlow({ mode: 'any' }))).toEqual(['MISSING_APPROVERS']);
  });

  it('rejects an empty approver list', () => {
    expectIssue(approvalFlow({ approvers: [], mode: 'any' }), {
      code: 'EMPTY_APPROVERS',
      path: 'nodes.a.approvers',
    });
  });

  it('rejects a non-array approver list', () => {
    expectIssue(approvalFlow({ approvers: role('x'), mode: 'any' }), {
      code: 'INVALID_TYPE',
      path: 'nodes.a.approvers',
    });
  });

  it('rejects group-only fields on a single-group node', () => {
    const flow = approvalFlow({
      approvers: [role('x')],
      mode: 'any',
      require: 'all',
      countAcrossGroups: true,
    });
    expect(codes(flow)).toEqual(['CONFLICTING_FIELD', 'CONFLICTING_FIELD']);
  });

  it('rejects single-group fields on a node with groups', () => {
    const flow = approvalFlow({
      groups: [{ id: 'g', approvers: [role('y')], mode: 'any' }],
      mode: 'all',
      excludeRequester: true,
    });
    expect(validateFlow(flow)).toEqual([
      expect.objectContaining({ code: 'CONFLICTING_FIELD', path: 'nodes.a.mode' }),
      expect.objectContaining({ code: 'CONFLICTING_FIELD', path: 'nodes.a.excludeRequester' }),
    ]);
  });

  it('rejects invalid duplicateApprover values', () => {
    const flow = approvalFlow({ approvers: [role('x')], mode: 'any', duplicateApprover: 'skip' });
    expectIssue(flow, { code: 'INVALID_VALUE', path: 'nodes.a.duplicateApprover' });
  });

  it('rejects non-boolean flags', () => {
    const flow = approvalFlow({ approvers: [role('x')], mode: 'any', excludeRequester: 'yes' });
    expectIssue(flow, { code: 'INVALID_TYPE', path: 'nodes.a.excludeRequester' });
  });

  describe('mode', () => {
    it('is required', () => {
      expectIssue(approvalFlow({ approvers: [role('x')] }), {
        code: 'MISSING_FIELD',
        path: 'nodes.a.mode',
      });
    });

    it('rejects unknown modes', () => {
      expectIssue(approvalFlow({ approvers: [role('x')], mode: 'most' }), {
        code: 'INVALID_VALUE',
        path: 'nodes.a.mode',
      });
    });

    it.each([0, -1, 2.5, '2', null])('rejects minimum %j', (minimum) => {
      expectIssue(approvalFlow({ approvers: [role('x')], mode: { minimum } }), {
        code: 'INVALID_MINIMUM',
        path: 'nodes.a.mode.minimum',
      });
    });

    it('rejects extra keys in { minimum }', () => {
      expectIssue(approvalFlow({ approvers: [role('x')], mode: { minimum: 1, maximum: 3 } }), {
        code: 'UNKNOWN_FIELD',
        path: 'nodes.a.mode.maximum',
      });
    });
  });

  describe('rejectPolicy', () => {
    it.each([0, 1.5, 'x'])('rejects { minimum: %j }', (minimum) => {
      expectIssue(
        approvalFlow({ approvers: [role('x')], mode: 'any', rejectPolicy: { minimum } }),
        {
          code: 'INVALID_REJECT_POLICY',
          path: 'nodes.a.rejectPolicy.minimum',
        },
      );
    });

    it('rejects unknown policies', () => {
      expectIssue(approvalFlow({ approvers: [role('x')], mode: 'any', rejectPolicy: 'never' }), {
        code: 'INVALID_REJECT_POLICY',
        path: 'nodes.a.rejectPolicy',
      });
    });
  });

  describe('static minimum for user approvers', () => {
    const users = [
      { type: 'user', value: ['u1', 'u2'] },
      { type: 'user', value: 'u1' },
    ];

    it('rejects a minimum above the number of unique users', () => {
      expectIssue(approvalFlow({ approvers: users, mode: { minimum: 3 } }), {
        code: 'MINIMUM_EXCEEDS_APPROVERS',
        path: 'nodes.a.mode.minimum',
      });
    });

    it('accepts a minimum equal to the number of unique users', () => {
      expect(validateFlow(approvalFlow({ approvers: users, mode: { minimum: 2 } }))).toEqual([]);
    });

    it('does not check groups with dynamic approvers', () => {
      const flow = approvalFlow({ approvers: [...users, role('x')], mode: { minimum: 3 } });
      expect(validateFlow(flow)).toEqual([]);
    });

    it('applies to each group', () => {
      const flow = approvalFlow({ groups: [{ id: 'g', approvers: users, mode: { minimum: 5 } }] });
      expectIssue(flow, { code: 'MINIMUM_EXCEEDS_APPROVERS', groupId: 'g' });
    });
  });

  describe('fallback approvers', () => {
    it('are required by onEmptyApprovers: "fallback"', () => {
      const flow = approvalFlow({
        approvers: [role('x')],
        mode: 'any',
        onEmptyApprovers: 'fallback',
      });
      expectIssue(flow, { code: 'MISSING_FALLBACK_APPROVERS', path: 'nodes.a.fallbackApprovers' });
    });

    it('are required by onInsufficientApprovers: "fallback"', () => {
      const flow = approvalFlow({
        groups: [
          {
            id: 'fin',
            approvers: [role('x')],
            mode: { minimum: 2 },
            onInsufficientApprovers: 'fallback',
          },
        ],
      });
      expectIssue(flow, { code: 'MISSING_FALLBACK_APPROVERS', nodeId: 'a', groupId: 'fin' });
    });

    it('must not be empty', () => {
      const flow = approvalFlow({
        approvers: [role('x')],
        mode: 'any',
        onEmptyApprovers: 'fallback',
        fallbackApprovers: [],
      });
      expectIssue(flow, { code: 'EMPTY_APPROVERS', path: 'nodes.a.fallbackApprovers' });
    });

    it('rejects unknown policies', () => {
      const flow = approvalFlow({
        approvers: [role('x')],
        mode: 'any',
        onEmptyApprovers: 'ignore',
        onInsufficientApprovers: 'skip',
      });
      expect(codes(flow)).toEqual(['INVALID_VALUE', 'INVALID_VALUE']);
    });
  });

  describe('groups', () => {
    const group = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      approvers: [role(id)],
      mode: 'any',
      ...extra,
    });

    it('must be a non-empty array', () => {
      expectIssue(approvalFlow({ groups: {} }), { code: 'INVALID_TYPE', path: 'nodes.a.groups' });
      expectIssue(approvalFlow({ groups: [] }), {
        code: 'EMPTY_APPROVERS',
        path: 'nodes.a.groups',
      });
    });

    it('must be objects', () => {
      expectIssue(approvalFlow({ groups: ['mgr'] }), {
        code: 'INVALID_TYPE',
        path: 'nodes.a.groups[0]',
      });
    });

    it('need at least one approver', () => {
      const flow = approvalFlow({
        groups: [group('mgr', { approvers: [] }), { id: 'fin', mode: 'any' }],
      });
      expectIssue(flow, { code: 'EMPTY_APPROVERS', groupId: 'mgr' });
      expectIssue(flow, {
        code: 'MISSING_FIELD',
        groupId: 'fin',
        path: 'nodes.a.groups[1].approvers',
      });
    });

    it('need unique ids', () => {
      const flow = approvalFlow({ groups: [group('mgr'), group('fin'), group('mgr')] });
      expect(validateFlow(flow)).toEqual([
        expect.objectContaining({
          code: 'DUPLICATE_GROUP_ID',
          groupId: 'mgr',
          path: 'nodes.a.groups[2].id',
        }),
      ]);
    });

    it('need a valid id', () => {
      const flow = approvalFlow({
        groups: [{ approvers: [role('x')], mode: 'any' }, group('two words')],
      });
      expectIssue(flow, { code: 'MISSING_FIELD', path: 'nodes.a.groups[0].id' });
      expectIssue(flow, { code: 'INVALID_ID', groupId: 'two words' });
    });

    it('report unknown fields and bad labels', () => {
      const flow = approvalFlow({ groups: [group('g', { label: 1, next: 'ok' })] });
      expectIssue(flow, { code: 'INVALID_TYPE', path: 'nodes.a.groups[0].label', groupId: 'g' });
      expectIssue(flow, { code: 'UNKNOWN_FIELD', path: 'nodes.a.groups[0].next', groupId: 'g' });
    });

    it('validate per-group rules with group context in the message', () => {
      const flow = approvalFlow({ groups: [group('fin', { mode: { minimum: 0 } })] });
      const [issue] = validateFlow(flow);
      expect(issue).toMatchObject({ code: 'INVALID_MINIMUM', nodeId: 'a', groupId: 'fin' });
      expect(issue?.message).toMatch(/^Node "a", group "fin": /);
    });

    it.each([
      [{ minimum: 0 }, 'nodes.a.require.minimum'],
      [{ minimum: 1.5 }, 'nodes.a.require.minimum'],
      [{ minimum: 3 }, 'nodes.a.require.minimum'],
      ['most', 'nodes.a.require'],
    ])('reject require %j', (require, path) => {
      const flow = approvalFlow({ groups: [group('a'), group('b')], require });
      expect(validateFlow(flow)).toEqual([
        expect.objectContaining({ code: 'INVALID_REQUIRE', path }),
      ]);
    });

    it('accept require.minimum equal to the number of groups', () => {
      const flow = approvalFlow({ groups: [group('a'), group('b')], require: { minimum: 2 } });
      expect(validateFlow(flow)).toEqual([]);
    });

    it('reject a non-boolean countAcrossGroups', () => {
      const flow = approvalFlow({ groups: [group('a')], countAcrossGroups: 'no' });
      expectIssue(flow, { code: 'INVALID_TYPE', path: 'nodes.a.countAcrossGroups' });
    });
  });

  describe('timeout', () => {
    const withTimeout = (timeout: unknown) =>
      approvalFlow({ approvers: [role('x')], mode: 'any', timeout });

    it('accepts a valid timeout', () => {
      expect(
        validateFlow(withTimeout({ after: 'P1DT12H', action: 'escalate', to: [role('y')] })),
      ).toEqual([]);
    });

    it.each(['3 days', 'P', 'PT', 'P1.5D', 'p3d', 5])('rejects duration %j', (after) => {
      expect(codes(withTimeout({ after, action: 'escalate', to: [role('y')] }))).toEqual([
        'INVALID_DURATION',
      ]);
    });

    it('requires after, action, and to', () => {
      expect(validateFlow(withTimeout({})).map((issue) => issue.path)).toEqual([
        'nodes.a.timeout.after',
        'nodes.a.timeout.action',
        'nodes.a.timeout.to',
      ]);
    });

    it('rejects unknown actions and fields', () => {
      const flow = withTimeout({ after: 'P1D', action: 'remind', to: [role('y')], every: 'P1D' });
      expect(codes(flow)).toEqual(['UNKNOWN_FIELD', 'INVALID_VALUE']);
    });

    it('rejects a non-object timeout', () => {
      expectIssue(withTimeout('P3D'), { code: 'INVALID_TYPE', path: 'nodes.a.timeout' });
    });
  });
});

describe('validateFlow: approver entries', () => {
  const withApprovers = (approvers: unknown[]) => approvalFlow({ approvers, mode: 'any' });

  it('rejects malformed entries', () => {
    const flow = withApprovers(['manager', { value: 'x' }, { type: '' }]);
    expect(validateFlow(flow).map((issue) => [issue.code, issue.path])).toEqual([
      ['INVALID_TYPE', 'nodes.a.approvers[0]'],
      ['MISSING_FIELD', 'nodes.a.approvers[1].type'],
      ['INVALID_TYPE', 'nodes.a.approvers[2].type'],
    ]);
  });

  it.each([
    ['user without value', { type: 'user' }],
    ['user with an empty array', { type: 'user', value: [] }],
    ['user with an empty id', { type: 'user', value: ['u1', ''] }],
    ['user with a number', { type: 'user', value: 7 }],
    ['field without value', { type: 'field' }],
    ['field with an array', { type: 'field', value: ['a'] }],
  ])('rejects %s', (_name, entry) => {
    expect(codes(withApprovers([entry]))).toEqual(['INVALID_APPROVER_CONFIG']);
  });

  it('rejects unknown keys on built-in types', () => {
    expect(codes(withApprovers([{ type: 'user', value: 'u1', level: 2 }]))).toEqual([
      'UNKNOWN_FIELD',
    ]);
  });

  it('allows any configuration on custom types', () => {
    expect(
      validateFlow(withApprovers([{ type: 'role', value: ['a', 'b'], scope: { dept: 'IT' } }])),
    ).toEqual([]);
  });

  describe('registration', () => {
    it('is not checked without approverTypes', () => {
      expect(validateFlow(withApprovers([role('x')]))).toEqual([]);
    });

    it('reports unregistered types everywhere approvers appear', () => {
      const flow = draft(kitchenSinkFlow);
      const issues = validateFlow(flow, { approverTypes: [], chains: ['supervisor'] });
      const paths = issues.filter((i) => i.code === 'UNKNOWN_APPROVER_TYPE').map((i) => i.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          'nodes.committee.fallbackApprovers[0].type',
          'nodes.boards.groups[0].approvers[0].type',
        ]),
      );
      const purchase = validateFlow(purchaseRequestFlow, {
        approverTypes: [],
        chains: ['supervisor'],
      });
      expect(purchase.map((i) => i.path)).toEqual(
        expect.arrayContaining(['nodes.supervisor.timeout.to[0].type', 'nodes.chain.until.type']),
      );
    });

    it('always knows the built-in types', () => {
      const flow = withApprovers([
        { type: 'user', value: 'u1' },
        { type: 'field', value: 'pic' },
      ]);
      expect(validateFlow(flow, { approverTypes: [] })).toEqual([]);
    });
  });
});

describe('validateFlow: approval-chain nodes', () => {
  it('accepts a minimal chain node', () => {
    expect(validateFlow(chainFlow({}), registries)).toEqual([]);
  });

  it('requires chain', () => {
    const flow = chainFlow({});
    delete flow.nodes.c.chain;
    expect(codes(flow)).toEqual(['MISSING_CHAIN']);
  });

  it('rejects an empty or non-string chain', () => {
    expect(codes(chainFlow({ chain: '' }))).toEqual(['INVALID_VALUE']);
    expect(codes(chainFlow({ chain: 1 }))).toEqual(['INVALID_TYPE']);
  });

  it('reports unregistered chains when chains are given', () => {
    expect(codes(chainFlow({ chain: 'manager' }), { chains: ['supervisor'] })).toEqual([
      'UNKNOWN_CHAIN',
    ]);
    expect(codes(chainFlow({ chain: 'manager' }))).toEqual([]);
  });

  it.each([undefined, 0, -2, 1.5, '5'])('rejects maxLevels %j', (maxLevels) => {
    const flow = chainFlow({ maxLevels });
    if (maxLevels === undefined) delete flow.nodes.c.maxLevels;
    expect(codes(flow)).toEqual(['INVALID_MAX_LEVELS']);
  });

  it.each(['manager', { field: '' }, { field: 'pic', extra: 1 }, { path: 'pic' }])(
    'rejects from %j',
    (from) => {
      expect(codes(chainFlow({ from }))).toEqual(['INVALID_VALUE']);
    },
  );

  it('validates until as an approver entry', () => {
    expectIssue(chainFlow({ until: 'director' }), { code: 'INVALID_TYPE', path: 'nodes.c.until' });
  });

  it('requires fallbackApprovers for onEmptyApprovers: "fallback"', () => {
    expect(codes(chainFlow({ onEmptyApprovers: 'fallback' }))).toEqual([
      'MISSING_FALLBACK_APPROVERS',
    ]);
  });

  it('validates the remaining options', () => {
    const flow = chainFlow({
      includeStopper: 'yes',
      excludeRequester: 1,
      duplicateApprover: 'always',
      onEmptyApprovers: 'cap',
      timeout: { after: 'soon', action: 'escalate', to: [role('x')] },
      mode: 'any',
    });
    expect(codes(flow).sort()).toEqual(
      [
        'INVALID_DURATION',
        'INVALID_TYPE',
        'INVALID_TYPE',
        'INVALID_VALUE',
        'INVALID_VALUE',
        'UNKNOWN_FIELD',
      ].sort(),
    );
  });
});

describe('validateFlow: layout', () => {
  it('rejects malformed layout entries', () => {
    const flow = draft();
    flow.layout = { supervisor: { x: 1 }, director: 'top', approved: { x: 0, y: 'a', z: 1 } };
    expect(validateFlow(flow).map((issue) => [issue.code, issue.path])).toEqual([
      ['INVALID_TYPE', 'layout.supervisor.y'],
      ['INVALID_TYPE', 'layout.director'],
      ['UNKNOWN_FIELD', 'layout.approved.z'],
      ['INVALID_TYPE', 'layout.approved.y'],
    ]);
  });

  it('rejects a non-object layout', () => {
    expectIssue({ ...draft(), layout: [] }, { code: 'INVALID_TYPE', path: 'layout' });
  });
});

describe('validateFlow: reporting', () => {
  it('collects every issue instead of stopping at the first', () => {
    const flow = draft();
    flow.id = 'bad id';
    flow.nodes.supervisor.mode = 'most';
    flow.nodes.director.next = 'ghost';
    flow.nodes.approved.result = 'maybe';
    expect(codes(flow)).toEqual([
      'INVALID_ID',
      'INVALID_VALUE',
      'UNKNOWN_NODE_REFERENCE',
      'INVALID_VALUE',
      'UNREACHABLE_NODE',
    ]);
  });

  it('prefixes messages with their location', () => {
    const flow = draft();
    flow.resubmitPolicy = 'x';
    flow.nodes.director.mode = 'x';
    const messages = validateFlow(flow).map((issue) => issue.message);
    expect(messages[0]).toMatch(/^Flow: /);
    expect(messages[1]).toMatch(/^Node "director": /);
  });

  it.each([
    ['a string', 'x', '"x"'],
    ['a number', 0, '0'],
    ['a boolean', true, 'true'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['an array', [], 'an array'],
    ['an object', {}, 'an object'],
    ['a function', () => 1, 'a function'],
  ])('describes %s in messages', (_name, version, described) => {
    const [issue] = validateFlow({ ...draft(), version });
    expect(issue?.message).toBe(`Flow: "version" must be an integer >= 1, got ${described}.`);
  });

  it('omits nodeId and groupId for flow-level issues', () => {
    const [issue] = validateFlow({ ...draft(), resubmitPolicy: 'x' });
    expect(issue).toEqual({
      code: 'INVALID_VALUE',
      path: 'resubmitPolicy',
      message: expect.any(String),
    });
  });
});
