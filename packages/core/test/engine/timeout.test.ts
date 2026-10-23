import { describe, expect, it, vi } from 'vitest';
import type { ApproverEntry, FlowDefinition, TimeoutConfig } from '../../src';
import { END_NODES, setup, singleStepFlow } from './helpers';

// The test clock starts at 2026-01-05T08:00:00Z.
const T0 = new Date('2026-01-05T08:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

const role = (value: string) => ({ type: 'role', value });
const escalateTo = (after: string, ...to: ApproverEntry[]): { timeout: TimeoutConfig } => ({
  timeout: { after, action: 'escalate', to },
});

describe('due dates', () => {
  it('sets due_at from the node timeout when the step is entered', async () => {
    const t = setup();
    const instance = await t.run(
      singleStepFlow({
        approvers: [role('manager')],
        mode: 'any',
        ...escalateTo('PT12H', role('director')),
      }),
    );
    expect((await t.state(instance.id)).steps[0]?.dueAt).toEqual(at(12));
    expect((await t.engine.findPendingForUser('m1')).items[0]?.dueAt).toEqual(at(12));
  });

  it('gives every chain level its own deadline', async () => {
    const t = setup();
    const flow = {
      id: 'chain',
      name: 'Chain',
      start: 'chain',
      nodes: {
        chain: {
          type: 'approval-chain',
          chain: 'supervisor',
          maxLevels: 3,
          ...escalateTo('P1D', role('director')),
          next: 'approved',
          onReject: 'rejected',
        },
        ...END_NODES,
      },
    } satisfies FlowDefinition;
    const instance = await t.run(flow);
    t.advance(12 * HOUR);
    await t.engine.approve(instance.id, 's1');
    const steps = (await t.state(instance.id)).steps;
    expect(steps.map((step) => step.dueAt)).toEqual([at(24), at(36)]);
  });

  it('starts a new deadline when a node is visited again', async () => {
    const t = setup();
    const flow = {
      id: 'revisit',
      name: 'Revisit',
      start: 'first',
      nodes: {
        first: {
          type: 'approval',
          approvers: [{ type: 'user', value: 'a1' }],
          mode: 'any',
          ...escalateTo('PT2H', role('director')),
          next: 'second',
          onReject: 'rejected',
        },
        second: {
          type: 'approval',
          approvers: [{ type: 'user', value: 'b1' }],
          mode: 'any',
          next: 'approved',
          onReject: 'rejected',
        },
        ...END_NODES,
      },
    } satisfies FlowDefinition;
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 'a1');
    t.advance(5 * HOUR);
    await t.engine.returnForRevision(instance.id, 'b1', 'again', { toNodeId: 'first' });
    expect((await t.state(instance.id)).steps.slice(-1)[0]?.dueAt).toEqual(at(7));
  });

  it('has no deadline without a timeout', async () => {
    const t = setup();
    const instance = await t.run(singleStepFlow({ approvers: [role('manager')], mode: 'any' }));
    expect((await t.state(instance.id)).steps[0]?.dueAt).toBeNull();
  });
});

describe('processTimeouts', () => {
  const managerStep = (extra: Record<string, unknown> = {}) =>
    singleStepFlow({
      approvers: [role('manager')],
      mode: 'any',
      ...escalateTo('PT12H', role('director')),
      ...extra,
    });

  it('does nothing before the deadline', async () => {
    const t = setup();
    const instance = await t.run(managerStep());
    expect(await t.engine.processTimeouts(at(11.99))).toEqual({ escalated: [], failed: [] });
    expect((await t.state(instance.id)).instance.revision).toBe(0);
  });

  it('escalates once the deadline has passed', async () => {
    const t = setup();
    const instance = await t.run(managerStep());
    const stepId = (await t.state(instance.id)).steps[0]?.id;

    const result = await t.engine.processTimeouts(at(12));
    expect(result).toEqual({ escalated: [{ instanceId: instance.id, stepId }], failed: [] });

    const state = await t.state(instance.id);
    expect(state.steps[0]?.dueAt).toBeNull();
    expect(state.steps[0]?.config.groups[1]).toEqual({
      id: '$escalation',
      mode: 'any',
      rejectPolicy: 'any',
      excludeRequester: false,
      status: 'pending',
      override: true,
    });
    expect(await t.slots(instance.id)).toEqual({
      default: ['m1:pending', 'm2:pending'],
      $escalation: ['d1:pending', 'd2:pending'],
    });
    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]).toMatchObject({
      action: 'escalated',
      actorId: null,
      stepId,
      timestamp: at(12),
      metadata: { approvers: ['d1', 'd2'], dueAt: '2026-01-05T20:00:00.000Z' },
    });
    expect(t.events.slice(-2)).toMatchObject([
      { name: 'timeout.escalated', payload: { approvers: ['d1', 'd2'], step: { dueAt: null } } },
      {
        name: 'approval.required',
        payload: {
          reason: 'escalated',
          groups: [{ groupId: '$escalation', userIds: ['d1', 'd2'] }],
        },
      },
    ]);
    expect((await t.engine.findPendingForUser('d1')).items[0]?.groupIds).toEqual(['$escalation']);
  });

  it('escalates a step only once', async () => {
    const t = setup();
    await t.run(managerStep());
    await t.engine.processTimeouts(at(12));
    expect(await t.engine.processTimeouts(at(48))).toEqual({ escalated: [], failed: [] });
  });

  it('uses the engine clock by default', async () => {
    const t = setup();
    const instance = await t.run(managerStep());
    t.advance(13 * HOUR);
    expect((await t.engine.processTimeouts()).escalated).toHaveLength(1);
    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]?.timestamp).toEqual(at(13));
  });

  it('lets one escalation approver decide the whole step', async () => {
    const t = setup();
    const flow = singleStepFlow({
      groups: [
        { id: 'mgr', approvers: [role('manager')], mode: 'all' },
        { id: 'fin', approvers: [role('finance')], mode: { minimum: 2 } },
      ],
      ...escalateTo('P2D', { type: 'user', value: 'ceo1' }),
    });
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 'f1');
    await t.engine.processTimeouts(at(48));
    expect((await t.engine.approve(instance.id, 'ceo1')).status).toBe('approved');
    expect(await t.slots(instance.id)).toEqual({
      mgr: ['m1:skipped', 'm2:skipped'],
      fin: ['f1:approved', 'f2:skipped', 'f3:skipped'],
      $escalation: ['ceo1:approved'],
    });
  });

  it('lets one escalation approver reject the whole step', async () => {
    const t = setup();
    const instance = await t.run(managerStep());
    await t.engine.processTimeouts(at(12));
    expect((await t.engine.reject(instance.id, 'd2', 'Too late')).status).toBe('rejected');
  });

  it('still lets the original approvers decide', async () => {
    const t = setup();
    const instance = await t.run(managerStep());
    await t.engine.processTimeouts(at(12));
    expect((await t.engine.approve(instance.id, 'm2')).status).toBe('approved');
    expect(await t.slots(instance.id)).toEqual({
      default: ['m1:skipped', 'm2:approved'],
      $escalation: ['d1:skipped', 'd2:skipped'],
    });
  });

  it('keeps the escalation group out of `require`', async () => {
    const t = setup();
    const flow = singleStepFlow({
      groups: [
        { id: 'a', approvers: [{ type: 'user', value: 'a1' }], mode: 'any' },
        { id: 'b', approvers: [{ type: 'user', value: 'b1' }], mode: 'any' },
      ],
      require: 'all',
      ...escalateTo('PT1H', role('director')),
    });
    const instance = await t.run(flow);
    await t.engine.processTimeouts(at(1));
    await t.engine.approve(instance.id, 'a1');
    expect((await t.engine.approve(instance.id, 'b1')).status).toBe('approved');
  });

  it('resolves escalation approvers relative to the instance and excludes the requester', async () => {
    const t = setup();
    const flow = singleStepFlow({
      approvers: [role('manager')],
      mode: 'any',
      excludeRequester: true,
      ...escalateTo('PT1H', { type: 'supervisor', level: 2 }, role('director')),
    });
    const instance = await t.run(flow, { requester: 'd1' });
    await t.engine.processTimeouts(at(1));
    // d1's second-level supervisor does not exist (ceo1 has none); d1 is the requester.
    expect((await t.slots(instance.id)).$escalation).toEqual(['d2:pending']);
  });

  it('records an escalation that finds nobody', async () => {
    const t = setup();
    const instance = await t.run(
      singleStepFlow({
        approvers: [role('manager')],
        mode: 'any',
        ...escalateTo('PT1H', role('nobody')),
      }),
    );
    expect((await t.engine.processTimeouts(at(1))).escalated).toHaveLength(1);
    const state = await t.state(instance.id);
    expect(state.steps[0]?.config.groups).toHaveLength(1);
    expect(state.steps[0]?.dueAt).toBeNull();
    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]?.metadata).toMatchObject({
      approvers: [],
    });
    expect(t.eventNames().slice(-1)).toEqual(['timeout.escalated']);
  });

  it('reports failures and carries on with the other instances', async () => {
    const t = setup();
    t.engine.registerApproverType('flaky', (_config, context) => {
      if (context.subject.id === '1') throw new Error('directory unavailable');
      return ['x1'];
    });
    const flow = singleStepFlow({
      approvers: [role('manager')],
      mode: 'any',
      ...escalateTo('PT1H', { type: 'flaky' }),
    });
    const broken = await t.run(flow, { subjectId: '1' });
    const fine = await t.run(flow, { subjectId: '2' });

    const result = await t.engine.processTimeouts(at(1));
    expect(result.escalated.map((entry) => entry.instanceId)).toEqual([fine.id]);
    expect(result.failed).toEqual([
      { instanceId: broken.id, error: new Error('directory unavailable') },
    ]);
    expect((await t.state(broken.id)).steps[0]?.dueAt).toEqual(at(1));
  });

  it('skips a step that was decided after it was found', async () => {
    const t = setup();
    const instance = await t.run(managerStep());
    const stale = await t.store.findTimedOut(at(12));
    await t.engine.approve(instance.id, 'm1');
    vi.spyOn(t.store, 'findTimedOut').mockResolvedValue(stale);

    expect(await t.engine.processTimeouts(at(12))).toEqual({ escalated: [], failed: [] });
    expect((await t.state(instance.id)).instance.revision).toBe(1);
  });
});
