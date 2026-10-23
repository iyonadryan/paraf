import { describe, expect, it } from 'vitest';
import { EmptyApproversError, InsufficientApproversError } from '../../src';
import type { FlowDefinition } from '../../src';
import { END_NODES, setup, singleStepFlow } from './helpers';

const role = (value: string | string[]) => ({ type: 'role', value });

describe('approval modes', () => {
  it('"any" needs one approval', async () => {
    const t = setup();
    const instance = await t.run(singleStepFlow({ approvers: [role('manager')], mode: 'any' }));
    expect((await t.engine.approve(instance.id, 'm2')).status).toBe('approved');
    expect(await t.slots(instance.id)).toEqual({ default: ['m1:skipped', 'm2:approved'] });
  });

  it('"all" needs every user with the role', async () => {
    const t = setup();
    const instance = await t.run(singleStepFlow({ approvers: [role('director')], mode: 'all' }));
    expect((await t.engine.approve(instance.id, 'd1')).status).toBe('in_progress');
    expect((await t.engine.approve(instance.id, 'd2')).status).toBe('approved');
  });

  it('{ minimum: 3 } needs three approvals', async () => {
    const t = setup();
    const instance = await t.run(
      singleStepFlow({ approvers: [role('committee')], mode: { minimum: 3 } }),
    );
    await t.engine.approve(instance.id, 'c1');
    await t.engine.approve(instance.id, 'c4');
    expect(await t.activeNode(instance.id)).toBe('step');
    expect((await t.engine.approve(instance.id, 'c2')).status).toBe('approved');
    expect(await t.slots(instance.id)).toEqual({
      default: ['c1:approved', 'c2:approved', 'c3:skipped', 'c4:approved'],
    });
  });

  it('merges several roles into one deduplicated group', async () => {
    const t = setup();
    // finance: f1 f2 f3; accounting: a1 f1.
    const instance = await t.run(
      singleStepFlow({ approvers: [role(['finance', 'accounting'])], mode: 'all' }),
    );
    expect(await t.slots(instance.id)).toEqual({
      default: ['f1:pending', 'f2:pending', 'f3:pending', 'a1:pending'],
    });
    for (const user of ['f1', 'f2', 'f3']) await t.engine.approve(instance.id, user);
    expect((await t.engine.approve(instance.id, 'a1')).status).toBe('approved');
  });

  it('gives one vote to a user produced by several approver entries', async () => {
    const t = setup();
    const flow = singleStepFlow({
      approvers: [role('manager'), { type: 'user', value: ['m1', 'x1'] }],
      mode: { minimum: 2 },
    });
    const instance = await t.run(flow);
    const state = await t.state(instance.id);
    expect(state.approvers.map((slot) => [slot.userId, slot.source])).toEqual([
      ['m1', { type: 'role', value: 'manager' }],
      ['m2', { type: 'role', value: 'manager' }],
      ['x1', { type: 'user', value: ['m1', 'x1'] }],
    ]);
    // m1 approving once is one vote; the minimum of 2 is not reached yet.
    expect((await t.engine.approve(instance.id, 'm1')).status).toBe('in_progress');
    expect((await t.engine.approve(instance.id, 'x1')).status).toBe('approved');
  });
});

describe('reject policies', () => {
  it('"any" (default for mode "all") fails on the first rejection', async () => {
    const t = setup();
    const instance = await t.run(singleStepFlow({ approvers: [role('director')], mode: 'all' }));
    expect((await t.engine.reject(instance.id, 'd2', 'no')).status).toBe('rejected');
    expect((await t.state(instance.id)).steps[0]?.config.groups[0]).toMatchObject({
      rejectPolicy: 'any',
      status: 'rejected',
    });
  });

  it('"impossible" (default for minimum) fails once the minimum is out of reach', async () => {
    const t = setup();
    const instance = await t.run(
      singleStepFlow({ approvers: [role('committee')], mode: { minimum: 3 } }),
    );
    expect((await t.engine.reject(instance.id, 'c1', 'no')).status).toBe('in_progress');
    expect((await t.engine.reject(instance.id, 'c2', 'no')).status).toBe('rejected');
    expect((await t.state(instance.id)).steps[0]?.config.groups[0]?.rejectPolicy).toBe(
      'impossible',
    );
  });

  it('"impossible" can still be approved after some rejections', async () => {
    const t = setup();
    const instance = await t.run(
      singleStepFlow({ approvers: [role('committee')], mode: { minimum: 2 } }),
    );
    await t.engine.reject(instance.id, 'c1', 'no');
    await t.engine.reject(instance.id, 'c2', 'no');
    await t.engine.approve(instance.id, 'c3');
    expect((await t.engine.approve(instance.id, 'c4')).status).toBe('approved');
  });

  it('{ minimum: n } fails after n rejections', async () => {
    const t = setup();
    const flow = singleStepFlow({
      approvers: [role('committee')],
      mode: 'any',
      rejectPolicy: { minimum: 2 },
    });
    const instance = await t.run(flow);
    expect((await t.engine.reject(instance.id, 'c1', 'no')).status).toBe('in_progress');
    expect((await t.engine.reject(instance.id, 'c2', 'no')).status).toBe('rejected');
  });

  it('{ minimum: n } still fails as soon as approval is impossible', async () => {
    const t = setup();
    const flow = singleStepFlow({
      approvers: [role('director')],
      mode: 'all',
      rejectPolicy: { minimum: 2 },
    });
    const instance = await t.run(flow);
    expect((await t.engine.reject(instance.id, 'd1', 'no')).status).toBe('rejected');
  });

  it('"any" on a minimum group fails on the first rejection', async () => {
    const t = setup();
    const flow = singleStepFlow({
      approvers: [role('committee')],
      mode: { minimum: 2 },
      rejectPolicy: 'any',
    });
    const instance = await t.run(flow);
    expect((await t.engine.reject(instance.id, 'c1', 'no')).status).toBe('rejected');
  });
});

describe('fewer approvers than the minimum', () => {
  // committee has 4 members.
  const flow = (extra: Record<string, unknown>) =>
    singleStepFlow({ approvers: [role('committee')], mode: { minimum: 5 }, ...extra });

  it('"error" (default) refuses to start', async () => {
    const t = setup();
    const error = await t.run(flow({})).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InsufficientApproversError);
    expect(error).toMatchObject({
      found: 4,
      minimum: 5,
      context: { nodeId: 'step', groupId: 'default' },
    });
    expect((await t.engine.findInstances({})).total).toBe(0);
  });

  it('"cap" lowers the minimum to the available approvers and records it', async () => {
    const t = setup();
    const instance = await t.run(flow({ onInsufficientApprovers: 'cap' }));
    const state = await t.state(instance.id);
    expect(state.steps[0]?.config.groups[0]).toMatchObject({ mode: { minimum: 5 }, minimum: 4 });
    const entered = (await t.engine.getHistory(instance.id)).find(
      (entry) => entry.action === 'step_entered',
    );
    expect(entered?.metadata).toMatchObject({ groups: [{ groupId: 'default', cappedMinimum: 4 }] });
    for (const user of ['c1', 'c2', 'c3']) await t.engine.approve(instance.id, user);
    expect((await t.engine.approve(instance.id, 'c4')).status).toBe('approved');
  });

  it('"fallback" adds fallback approvers until there are enough', async () => {
    const t = setup();
    const instance = await t.run(
      flow({
        onInsufficientApprovers: 'fallback',
        fallbackApprovers: [{ type: 'user', value: ['c1', 'x1', 'x2'] }],
      }),
    );
    expect(await t.slots(instance.id)).toEqual({
      default: ['c1:pending', 'c2:pending', 'c3:pending', 'c4:pending', 'x1:pending'],
    });
  });

  it('"fallback" behaves like "error" when still short', async () => {
    const t = setup();
    await expect(
      t.run(
        flow({
          onInsufficientApprovers: 'fallback',
          fallbackApprovers: [{ type: 'user', value: 'c1' }],
        }),
      ),
    ).rejects.toThrow(InsufficientApproversError);
  });
});

describe('empty approver lists', () => {
  const flow = (extra: Record<string, unknown>) =>
    singleStepFlow({ approvers: [role('nobody')], mode: 'any', ...extra });

  it('"error" (default) refuses to start', async () => {
    const t = setup();
    await expect(t.run(flow({}))).rejects.toThrow(EmptyApproversError);
  });

  it('"skip" skips the step and records it', async () => {
    const t = setup();
    const instance = await t.run(flow({ onEmptyApprovers: 'skip' }));
    expect(instance.status).toBe('approved');
    const state = await t.state(instance.id);
    expect(state.steps[0]).toMatchObject({ status: 'skipped' });
    expect(state.steps[0]?.config.groups[0]?.status).toBe('skipped');
    expect(await t.actions(instance.id)).toEqual([
      'started',
      'step_entered',
      'skipped',
      'skipped',
      'completed',
    ]);
    expect(t.eventNames()).not.toContain('approval.required');
  });

  it('"fallback" uses the fallback approvers', async () => {
    const t = setup();
    const instance = await t.run(
      flow({ onEmptyApprovers: 'fallback', fallbackApprovers: [{ type: 'user', value: 'x1' }] }),
    );
    expect(await t.slots(instance.id)).toEqual({ default: ['x1:pending'] });
    const entered = (await t.engine.getHistory(instance.id)).find(
      (entry) => entry.action === 'step_entered',
    );
    expect(entered?.metadata).toMatchObject({ groups: [{ fallback: 'empty' }] });
  });

  it('"fallback" fails when the fallback is empty too', async () => {
    const t = setup();
    await expect(
      t.run(flow({ onEmptyApprovers: 'fallback', fallbackApprovers: [role('nobody')] })),
    ).rejects.toThrow(EmptyApproversError);
  });
});

describe('the requester as approver', () => {
  it('excludeRequester removes the requester', async () => {
    const t = setup();
    const flow = singleStepFlow({
      approvers: [role('director')],
      mode: 'all',
      excludeRequester: true,
    });
    const instance = await t.run(flow, { requester: 'd1' });
    expect(await t.slots(instance.id)).toEqual({ default: ['d2:pending'] });
  });

  it('without excludeRequester the requester can approve', async () => {
    const t = setup();
    const instance = await t.run(singleStepFlow({ approvers: [role('director')], mode: 'any' }), {
      requester: 'd1',
    });
    expect((await t.engine.approve(instance.id, 'd1')).status).toBe('approved');
  });

  it('skips the top level when the requester is the only approver there', async () => {
    // The CEO submits: the manager approves, then the CEO level is empty and skipped.
    const t = setup();
    const flow = {
      id: 'ceo-request',
      name: 'CEO request',
      start: 'manager',
      nodes: {
        manager: {
          type: 'approval',
          approvers: [role('manager')],
          mode: 'any',
          next: 'ceo',
          onReject: 'rejected',
        },
        ceo: {
          type: 'approval',
          approvers: [role('ceo')],
          mode: 'any',
          excludeRequester: true,
          onEmptyApprovers: 'skip',
          next: 'approved',
          onReject: 'rejected',
        },
        ...END_NODES,
      },
    } satisfies FlowDefinition;
    const instance = await t.run(flow, { requester: 'ceo1' });
    expect((await t.engine.approve(instance.id, 'm1')).status).toBe('approved');
    const steps = (await t.state(instance.id)).steps;
    expect(steps.map((step) => [step.nodeId, step.status])).toEqual([
      ['manager', 'approved'],
      ['ceo', 'skipped'],
    ]);
  });
});
