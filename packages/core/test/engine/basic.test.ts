import { describe, expect, it, vi } from 'vitest';
import {
  ConditionEvaluationError,
  createEngine,
  EmptyApproversError,
  FlowNotFoundError,
  InstanceNotFoundError,
  InvalidArgumentError,
  InvalidStateError,
  NotAuthorizedError,
  NotImplementedError,
  UnknownApproverTypeError,
} from '../../src';
import type { FlowDefinition } from '../../src';
import { END_NODES, setup, singleStepFlow, twoLevelFlow } from './helpers';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Amount above 10M goes to the director, otherwise to a manager. */
const branchingFlow = {
  id: 'purchase',
  name: 'Purchase',
  start: 'supervisor',
  nodes: {
    supervisor: {
      type: 'approval',
      approvers: [{ type: 'supervisor', level: 1 }],
      mode: 'any',
      next: 'checkAmount',
      onReject: 'rejected',
    },
    checkAmount: {
      type: 'condition',
      rules: [{ when: { '>': [{ var: 'amount' }, 10_000_000] }, next: 'director' }],
      else: 'manager',
    },
    director: {
      type: 'approval',
      approvers: [{ type: 'role', value: 'director' }],
      mode: 'any',
      next: 'approved',
      onReject: 'rejected',
    },
    manager: {
      type: 'approval',
      approvers: [{ type: 'role', value: 'manager' }],
      mode: 'any',
      next: 'approved',
      onReject: 'rejected',
    },
    ...END_NODES,
  },
} satisfies FlowDefinition;

describe('multi-level approval', () => {
  it('runs supervisor then director', async () => {
    const t = setup();
    const started = await t.run(twoLevelFlow);
    expect(started).toMatchObject({ status: 'pending', round: 1, revision: 0, requesterId: 'u7' });
    expect(started.id).toMatch(UUID_V7);
    expect(await t.activeNode(started.id)).toBe('supervisor');
    expect(await t.slots(started.id)).toEqual({ default: ['s1:pending'] });

    // The director level is only notified after the supervisor approved.
    expect((await t.engine.findPendingForUser('d1')).total).toBe(0);
    const afterSupervisor = await t.engine.approve(started.id, 's1', 'ok');
    expect(afterSupervisor).toMatchObject({ status: 'in_progress', revision: 1 });
    expect(await t.activeNode(started.id)).toBe('director');
    expect(await t.slots(started.id)).toEqual({ default: ['d1:pending', 'd2:pending'] });

    t.advance(60_000);
    const done = await t.engine.approve(started.id, 'd2');
    expect(done).toMatchObject({ status: 'approved', currentStepId: null });
    expect(done.completedAt).toEqual(new Date('2026-01-05T08:01:00.000Z'));
    expect(await t.slots(started.id)).toEqual({ default: ['d1:skipped', 'd2:approved'] });

    const state = await t.state(started.id);
    expect(
      state.steps.map((step) => [
        step.nodeId,
        step.status,
        step.iteration,
        step.chainLevel,
        step.round,
      ]),
    ).toEqual([
      ['supervisor', 'approved', 1, 0, 1],
      ['director', 'approved', 1, 0, 1],
    ]);
    expect(await t.actions(started.id)).toEqual([
      'started',
      'step_entered',
      'approved',
      'step_entered',
      'approved',
      'completed',
    ]);
  });

  it('stops at the first rejection', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    const done = await t.engine.reject(instance.id, 's1', 'Budget is exhausted');
    expect(done.status).toBe('rejected');
    const state = await t.state(instance.id);
    expect(state.steps.map((step) => step.nodeId)).toEqual(['supervisor']);
    expect(state.approvers[0]).toMatchObject({
      status: 'rejected',
      comment: 'Budget is exhausted',
    });
    expect(state.approvers[0]?.decidedAt).toBeInstanceOf(Date);
  });
});

describe('condition branching', () => {
  it.each([
    [15_000_000, 'director', 0],
    [5_000_000, 'manager', null],
  ])('routes amount %d to %s', async (amount, node, matchedRule) => {
    const t = setup();
    const instance = await t.run(branchingFlow, { document: { amount } });
    await t.engine.approve(instance.id, 's1');
    expect(await t.activeNode(instance.id)).toBe(node);
    const condition = (await t.engine.getHistory(instance.id)).find(
      (entry) => entry.action === 'condition_evaluated',
    );
    expect(condition).toMatchObject({
      nodeId: 'checkAmount',
      actorId: null,
      metadata: { matchedRule, next: node },
    });
  });

  it('completes immediately when a condition leads straight to an end node', async () => {
    const t = setup();
    const flow = {
      id: 'auto',
      name: 'Auto',
      start: 'check',
      nodes: {
        check: {
          type: 'condition',
          rules: [{ when: { '<': [{ var: 'amount' }, 100] }, next: 'approved' }],
          else: 'review',
        },
        review: {
          type: 'approval',
          approvers: [{ type: 'role', value: 'manager' }],
          mode: 'any',
          next: 'approved',
          onReject: 'rejected',
        },
        ...END_NODES,
      },
    } satisfies FlowDefinition;
    const instance = await t.run(flow, { document: { amount: 50 } });
    expect(instance.status).toBe('approved');
    expect(await t.actions(instance.id)).toEqual(['started', 'condition_evaluated', 'completed']);
  });

  it('uses custom operators', async () => {
    const t = setup();
    t.engine.registerOperator('startsWith', ([text, prefix]) =>
      String(text).startsWith(String(prefix)),
    );
    const flow = {
      id: 'ops',
      name: 'Ops',
      start: 'check',
      nodes: {
        check: {
          type: 'condition',
          rules: [{ when: { startsWith: [{ var: 'code' }, 'IT-'] }, next: 'approved' }],
          else: 'rejected',
        },
        ...END_NODES,
      },
    } satisfies FlowDefinition;
    expect((await t.run(flow, { document: { code: 'IT-42' } })).status).toBe('approved');
    expect((await t.run(flow, { subjectId: '2', document: { code: 'HR-1' } })).status).toBe(
      'rejected',
    );
  });

  it('fails when an operator is no longer registered', async () => {
    const t = setup();
    t.engine.registerOperator('odd', ([value]) => Number(value) % 2 === 1);
    await t.publish({
      id: 'ops',
      name: 'Ops',
      start: 'check',
      nodes: {
        check: {
          type: 'condition',
          rules: [{ when: { odd: [1] }, next: 'approved' }],
          else: 'rejected',
        },
        ...END_NODES,
      },
    });
    const restarted = createEngine({ store: t.store });
    await expect(
      restarted.start('ops', { subject: { type: 'doc', id: '1' }, requester: { id: 'u7' } }),
    ).rejects.toThrow(ConditionEvaluationError);
  });

  it('refuses to replace built-in operators', () => {
    const t = setup();
    for (const name of ['==', 'var', 'and', '']) {
      expect(() => {
        t.engine.registerOperator(name, () => true);
      }).toThrow(InvalidArgumentError);
    }
  });
});

describe('built-in approver types', () => {
  it('resolves users from a document field', async () => {
    const t = setup();
    const flow = singleStepFlow({ approvers: [{ type: 'field', value: 'pic.ids' }], mode: 'all' });
    const instance = await t.run(flow, { document: { pic: { ids: ['p1', 'p2', 7, ''] } } });
    expect(await t.slots(instance.id)).toEqual({ default: ['p1:pending', 'p2:pending'] });
  });

  it('resolves fixed users', async () => {
    const t = setup();
    const instance = await t.run(
      singleStepFlow({ approvers: [{ type: 'user', value: 'x1' }], mode: 'any' }),
    );
    expect(await t.slots(instance.id)).toEqual({ default: ['x1:pending'] });
  });

  it('lists approver types with editor metadata', () => {
    const t = setup();
    const types = t.engine.getApproverTypes();
    expect(types.map((type) => type.type)).toEqual(['user', 'field', 'role', 'supervisor']);
    expect(types.find((type) => type.type === 'role')).toMatchObject({
      label: 'By role',
      configSchema: { value: { type: 'multiselect' } },
    });
    expect(types.find((type) => type.type === 'supervisor')?.label).toBe('supervisor');
  });

  it('fails clearly when a flow uses an unregistered type', async () => {
    const t = setup();
    await t.publish(twoLevelFlow);
    const bare = createEngine({ store: t.store });
    const error = await bare
      .start('two-level', { subject: { type: 'doc', id: '1' }, requester: { id: 'u7' } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnknownApproverTypeError);
    expect(error).toMatchObject({
      approverType: 'supervisor',
      context: { nodeId: 'supervisor', groupId: 'default' },
    });
    expect((await t.engine.findInstances({})).total).toBe(0);
  });

  it('rejects registering a type without a name', () => {
    const t = setup();
    expect(() => {
      t.engine.registerApproverType('', () => []);
    }).toThrow(TypeError);
  });
});

describe('failing to enter a step', () => {
  const flow = {
    id: 'fails',
    name: 'Fails',
    start: 'first',
    nodes: {
      first: {
        type: 'approval',
        approvers: [{ type: 'user', value: 's1' }],
        mode: 'any',
        next: 'second',
        onReject: 'rejected',
      },
      second: {
        type: 'approval',
        approvers: [{ type: 'role', value: 'nobody' }],
        mode: 'any',
        next: 'approved',
        onReject: 'rejected',
      },
      ...END_NODES,
    },
  } satisfies FlowDefinition;

  it('rolls the action back and records the failure', async () => {
    const t = setup();
    const instance = await t.run(flow);
    const error = await t.engine.approve(instance.id, 's1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmptyApproversError);
    expect((error as Error).message).toContain('node "second", group "default"');

    const state = await t.state(instance.id);
    expect(state.instance).toMatchObject({ status: 'pending', revision: 0 });
    expect(await t.slots(instance.id)).toEqual({ default: ['s1:pending'] });
    const failure = (await t.engine.getHistory(instance.id)).slice(-1)[0];
    expect(failure).toMatchObject({
      action: 'step_failed',
      actorId: 's1',
      nodeId: 'second',
      metadata: { code: 'EMPTY_APPROVERS', groupId: 'default' },
    });
  });

  it('records unregistered approver types as failures', async () => {
    const t = setup();
    const instance = await t.run(flow);
    // An engine on the same store that never registered the role type.
    const bare = createEngine({ store: t.store });
    await expect(bare.approve(instance.id, 's1')).rejects.toThrow(UnknownApproverTypeError);
    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]).toMatchObject({
      action: 'step_failed',
      metadata: { code: 'UNKNOWN_APPROVER_TYPE', groupId: 'default' },
    });
  });
});

describe('action validation', () => {
  it('rejects unknown instances and flows', async () => {
    const t = setup();
    await expect(t.engine.approve('nope', 'u1')).rejects.toThrow(InstanceNotFoundError);
    await expect(
      t.engine.start('nope', { subject: { type: 'doc', id: '1' }, requester: { id: 'u7' } }),
    ).rejects.toThrow(FlowNotFoundError);
  });

  it.each([
    [{ type: '', id: '1' }, 'u7', 'subject.type'],
    [{ type: 'doc', id: ' ' }, 'u7', 'subject.id'],
    [{ type: 'doc', id: '1' }, '', 'requester.id'],
  ])('rejects invalid start input %j / %j', async (subject, requester, field) => {
    const t = setup();
    await t.publish(twoLevelFlow);
    await expect(
      t.engine.start('two-level', { subject, requester: { id: requester } }),
    ).rejects.toThrow(`"${field}" must be a non-empty string`);
  });

  it('only lets pending approvers decide', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    const error = await t.engine.approve(instance.id, 'd1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotAuthorizedError);
    expect(error).toMatchObject({
      code: 'NOT_AUTHORIZED',
      context: { action: 'approve', instanceId: instance.id, userId: 'd1', nodeId: 'supervisor' },
    });
    await t.engine.approve(instance.id, 's1');
    await expect(t.engine.approve(instance.id, 's1')).rejects.toThrow(NotAuthorizedError);
  });

  it('requires a comment to reject', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await expect(t.engine.reject(instance.id, 's1', '  ')).rejects.toThrow(InvalidArgumentError);
  });

  it('refuses decisions on finished instances', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await t.engine.reject(instance.id, 's1', 'no');
    const error = await t.engine.approve(instance.id, 's1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidStateError);
    expect((error as Error).message).toContain('already rejected');
  });

  it('reports approval-chain nodes as not implemented yet', async () => {
    const t = setup();
    const flow = {
      id: 'chain',
      name: 'Chain',
      start: 'c',
      nodes: {
        c: {
          type: 'approval-chain',
          chain: 'supervisor',
          maxLevels: 3,
          next: 'approved',
          onReject: 'rejected',
        },
        ...END_NODES,
      },
    } satisfies FlowDefinition;
    await expect(t.run(flow)).rejects.toThrow(NotImplementedError);
  });
});

describe('audit trail', () => {
  it('records actors, comments, and system entries', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await t.engine.approve(instance.id, 's1', 'fine');
    const history = await t.engine.getHistory(instance.id);
    for (const entry of history) {
      expect(entry.id).toMatch(UUID_V7);
      expect(entry.instanceId).toBe(instance.id);
      expect(entry.timestamp).toBeInstanceOf(Date);
    }
    expect(history[0]).toMatchObject({ action: 'started', actorId: 'u7', stepId: null });
    expect(history[1]).toMatchObject({
      action: 'step_entered',
      actorId: null,
      nodeId: 'supervisor',
    });
    expect(history[1]?.metadata).toEqual({
      iteration: 1,
      groups: [{ groupId: 'default', approvers: ['s1'] }],
    });
    expect(history[2]).toMatchObject({
      action: 'approved',
      actorId: 's1',
      comment: 'fine',
      metadata: { groupIds: ['default'] },
    });
  });

  it('uses a custom ID generator', async () => {
    let next = 0;
    const t = setup({ generateId: () => `id-${++next}` });
    const instance = await t.run(twoLevelFlow);
    expect(instance.id).toBe('id-1');
  });
});

describe('events', () => {
  it('emits lifecycle events in order with subject and final state', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await t.engine.approve(instance.id, 's1');
    await t.engine.approve(instance.id, 'd1');
    expect(t.eventNames()).toEqual([
      'instance.created',
      'step.entered',
      'approval.required',
      'step.completed',
      'step.entered',
      'approval.required',
      'step.completed',
      'instance.completed',
    ]);
    const required = t.events.find((event) => event.name === 'approval.required');
    expect(required?.payload).toMatchObject({
      reason: 'entered',
      instance: { subject: { type: 'doc', id: '1' } },
      groups: [{ groupId: 'default', userIds: ['s1'] }],
    });
    const completed = t.events.slice(-1)[0]?.payload as {
      instance: { status: string; subject: object };
    };
    expect(completed.instance).toMatchObject({
      status: 'approved',
      subject: { type: 'doc', id: '1' },
    });
  });

  it('reports handler errors without failing the action', async () => {
    const onEventError = vi.fn();
    const t = setup({ onEventError });
    const failure = new Error('mail server down');
    t.engine.on('approval.required', () => {
      throw failure;
    });
    const instance = await t.run(twoLevelFlow);
    expect(instance.status).toBe('pending');
    expect(onEventError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ name: 'approval.required' }),
    );
  });

  it('logs handler errors to the console by default', async () => {
    const t = setup({ onEventError: undefined });
    const engine = createEngine({ store: t.store });
    engine.registerApproverType('supervisor', () => ['s1']);
    engine.registerApproverType('role', () => ['d1']);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    engine.on('instance.created', () => Promise.reject(new Error('boom')));
    await engine.publishFlow(twoLevelFlow);
    await engine.start('two-level', { subject: { type: 'doc', id: '1' }, requester: { id: 'u7' } });
    expect(log).toHaveBeenCalledWith(
      'Paraf: a handler of "instance.created" failed.',
      expect.any(Error),
    );
    log.mockRestore();
  });

  it('stops calling a handler after unsubscribing', async () => {
    const t = setup();
    const handler = vi.fn();
    const off = t.engine.on('instance.created', handler);
    await t.run(twoLevelFlow);
    off();
    await t.run(twoLevelFlow, { subjectId: '2' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('hands out copies of the state', async () => {
    const t = setup();
    t.engine.on('instance.created', ({ instance }) => {
      instance.status = 'cancelled';
    });
    const instance = await t.run(twoLevelFlow);
    expect((await t.state(instance.id)).instance.status).toBe('pending');
  });
});
