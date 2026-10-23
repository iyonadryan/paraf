import { describe, expect, it } from 'vitest';
import {
  DelegationError,
  InsufficientApproversError,
  InvalidArgumentError,
  InvalidStateError,
  NotAuthorizedError,
} from '../../src';
import type { FlowDefinition } from '../../src';
import { setup, singleStepFlow, twoLevelFlow } from './helpers';

const role = (value: string) => ({ type: 'role', value });

describe('returnForRevision and resubmit', () => {
  it('returns to the requester', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await t.engine.approve(instance.id, 's1');
    const returned = await t.engine.returnForRevision(instance.id, 'd1', 'Attach the quotation');
    expect(returned).toMatchObject({ status: 'returned', currentStepId: null });

    const state = await t.state(instance.id);
    expect(state.steps[1]).toMatchObject({
      status: 'returned',
      config: { resubmitPolicy: 'restart' },
    });
    expect(await t.slots(instance.id)).toEqual({ default: ['d1:skipped', 'd2:skipped'] });
    expect((await t.engine.findPendingForUser('d2')).total).toBe(0);
    const event = t.events.find((e) => e.name === 'instance.returned');
    expect(event?.payload).toMatchObject({ toNodeId: null, instance: { status: 'returned' } });
    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]).toMatchObject({
      action: 'returned',
      actorId: 'd1',
      comment: 'Attach the quotation',
      metadata: { toNodeId: null, resubmitPolicy: 'restart' },
    });
    await expect(t.engine.approve(instance.id, 'd1')).rejects.toThrow(InvalidStateError);
  });

  it('restart: every level approves again in a new round', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow, { document: { amount: 1 } as never });
    await t.engine.approve(instance.id, 's1');
    await t.engine.returnForRevision(instance.id, 'd1', 'fix it');
    const resubmitted = await t.engine.resubmit(instance.id, 'u7', { amount: 2 });
    expect(resubmitted).toMatchObject({ status: 'pending', round: 2, document: { amount: 2 } });

    const state = await t.state(instance.id);
    expect(
      state.steps.map((step) => [step.nodeId, step.iteration, step.round, step.status]),
    ).toEqual([
      ['supervisor', 1, 1, 'approved'],
      ['director', 1, 1, 'returned'],
      ['supervisor', 2, 2, 'active'],
    ]);
    await t.engine.approve(instance.id, 's1');
    expect((await t.engine.approve(instance.id, 'd2')).status).toBe('approved');
    expect(
      (await t.engine.getHistory(instance.id)).find((e) => e.action === 'resubmitted')?.metadata,
    ).toEqual({
      round: 2,
      resubmitPolicy: 'restart',
    });
  });

  it('resume: continues at the node that returned the document', async () => {
    const t = setup();
    const instance = await t.run({ ...twoLevelFlow, resubmitPolicy: 'resume' });
    await t.engine.approve(instance.id, 's1');
    await t.engine.returnForRevision(instance.id, 'd1', 'fix it');
    const resubmitted = await t.engine.resubmit(instance.id, 'u7');
    expect(resubmitted.document).toEqual({});
    expect(await t.activeNode(instance.id)).toBe('director');
    const steps = (await t.state(instance.id)).steps;
    expect(steps.slice(-1)[0]).toMatchObject({ nodeId: 'director', iteration: 2, round: 2 });
  });

  it('lets one return override the flow policy', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await t.engine.approve(instance.id, 's1');
    await t.engine.returnForRevision(instance.id, 'd1', 'fix it', { resubmitPolicy: 'resume' });
    await t.engine.resubmit(instance.id, 'u7');
    expect(await t.activeNode(instance.id)).toBe('director');
  });

  it('returns to a node visited earlier without involving the requester', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await t.engine.approve(instance.id, 's1');
    const returned = await t.engine.returnForRevision(instance.id, 'd1', 'check again', {
      toNodeId: 'supervisor',
    });
    expect(returned).toMatchObject({ status: 'in_progress', round: 1 });
    expect(await t.activeNode(instance.id)).toBe('supervisor');
    expect((await t.state(instance.id)).steps.slice(-1)[0]).toMatchObject({
      iteration: 2,
      round: 1,
    });
    const event = t.events.find((e) => e.name === 'instance.returned');
    expect(event?.payload).toMatchObject({ toNodeId: 'supervisor' });
  });

  it('only returns to nodes visited in the current round', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await expect(
      t.engine.returnForRevision(instance.id, 's1', 'x', { toNodeId: 'director' }),
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('is allowed for pending approvers and admins only', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await expect(t.engine.returnForRevision(instance.id, 'u7', 'x')).rejects.toThrow(
      NotAuthorizedError,
    );
    expect((await t.engine.returnForRevision(instance.id, 'admin', 'x')).status).toBe('returned');
  });

  it('requires a comment', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await expect(t.engine.returnForRevision(instance.id, 's1', '')).rejects.toThrow(
      InvalidArgumentError,
    );
  });

  it('lets only the requester resubmit, and only a returned instance', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await expect(t.engine.resubmit(instance.id, 'u7')).rejects.toThrow(InvalidStateError);
    await t.engine.returnForRevision(instance.id, 's1', 'x');
    await expect(t.engine.resubmit(instance.id, 's1')).rejects.toThrow(NotAuthorizedError);
  });
});

describe('delegate', () => {
  it('moves the vote to another user', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    const delegated = await t.engine.delegate(instance.id, 's1', 'x9', 'On leave');
    expect(delegated.status).toBe('in_progress');
    const state = await t.state(instance.id);
    expect(state.approvers.map((slot) => [slot.userId, slot.status, slot.delegatedFrom])).toEqual([
      ['s1', 'delegated', null],
      ['x9', 'pending', 's1'],
    ]);
    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]).toMatchObject({
      action: 'delegated',
      actorId: 's1',
      comment: 'On leave',
      metadata: { to: 'x9', groupIds: ['default'] },
    });
    expect(t.events.slice(-1)[0]).toMatchObject({
      name: 'approval.required',
      payload: { reason: 'delegated', groups: [{ groupId: 'default', userIds: ['x9'] }] },
    });
    await expect(t.engine.approve(instance.id, 's1')).rejects.toThrow(NotAuthorizedError);
    await t.engine.approve(instance.id, 'x9');
    expect(await t.activeNode(instance.id)).toBe('director');
  });

  it('keeps one vote when delegating to an existing approver ("all" needs one approval less)', async () => {
    const t = setup();
    const instance = await t.run(singleStepFlow({ approvers: [role('director')], mode: 'all' }));
    await t.engine.delegate(instance.id, 'd1', 'd2');
    expect(await t.slots(instance.id)).toEqual({ default: ['d1:delegated', 'd2:pending'] });
    expect((await t.engine.approve(instance.id, 'd2')).status).toBe('approved');
  });

  it('completes the step when the delegate already approved', async () => {
    const t = setup();
    const instance = await t.run(singleStepFlow({ approvers: [role('director')], mode: 'all' }));
    await t.engine.approve(instance.id, 'd2');
    expect((await t.engine.delegate(instance.id, 'd1', 'd2')).status).toBe('approved');
  });

  it('refuses a delegation that makes the minimum unreachable', async () => {
    const t = setup();
    const instance = await t.run(
      singleStepFlow({ approvers: [role('committee')], mode: { minimum: 4 } }),
    );
    const error = await t.engine
      .delegate(instance.id, 'c1', 'c2')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DelegationError);
    expect(error).toMatchObject({ context: { groupId: 'default' } });
    expect(await t.slots(instance.id)).toEqual({
      default: ['c1:pending', 'c2:pending', 'c3:pending', 'c4:pending'],
    });
  });

  it('allows a delegation to an existing approver when the minimum stays reachable', async () => {
    const t = setup();
    const instance = await t.run(
      singleStepFlow({ approvers: [role('committee')], mode: { minimum: 3 } }),
    );
    await t.engine.delegate(instance.id, 'c1', 'c2');
    await t.engine.approve(instance.id, 'c2');
    await t.engine.approve(instance.id, 'c3');
    expect((await t.engine.approve(instance.id, 'c4')).status).toBe('approved');
  });

  it('applies to every group of the delegator', async () => {
    const t = setup();
    const flow = singleStepFlow({
      groups: [
        { id: 'mgr', approvers: [role('manager')], mode: 'all' },
        { id: 'pic', approvers: [{ type: 'user', value: ['m1', 'x1'] }], mode: 'any' },
      ],
    });
    const instance = await t.run(flow);
    await t.engine.delegate(instance.id, 'm1', 'x1');
    expect(await t.slots(instance.id)).toEqual({
      mgr: ['m1:delegated', 'm2:pending', 'x1:pending'],
      pic: ['m1:delegated', 'x1:pending'],
    });
    // x1 is a delegate in "mgr" and already an approver in "pic": one decision counts in both.
    await t.engine.approve(instance.id, 'x1');
    expect((await t.engine.approve(instance.id, 'm2')).status).toBe('approved');
  });

  it('ignores groups that are already decided when checking the minimum', async () => {
    const t = setup();
    const flow = singleStepFlow({
      groups: [
        { id: 'mgr', label: 'Manager', approvers: [role('manager')], mode: 'any' },
        { id: 'fin', label: 'Finance', approvers: [role('finance')], mode: { minimum: 2 } },
      ],
    });
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 'm1');
    await t.engine.delegate(instance.id, 'f1', 'x1');
    expect(t.events.slice(-1)[0]?.payload).toMatchObject({
      reason: 'delegated',
      groups: [{ groupId: 'fin', label: 'Finance', userIds: ['x1'] }],
    });
    await t.engine.approve(instance.id, 'x1');
    expect((await t.engine.approve(instance.id, 'f2')).status).toBe('approved');
  });

  it('can hand the vote back', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await t.engine.delegate(instance.id, 's1', 'x9');
    await t.engine.delegate(instance.id, 'x9', 's1');
    expect(
      (await t.state(instance.id)).approvers.map((slot) => [
        slot.userId,
        slot.status,
        slot.delegatedFrom,
      ]),
    ).toEqual([
      ['s1', 'pending', 'x9'],
      ['x9', 'delegated', 's1'],
    ]);
  });

  it('rejects invalid delegations', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await expect(t.engine.delegate(instance.id, 's1', 's1')).rejects.toThrow(DelegationError);
    await expect(t.engine.delegate(instance.id, 's1', '')).rejects.toThrow(DelegationError);
    await expect(t.engine.delegate(instance.id, 'd1', 'x1')).rejects.toThrow(NotAuthorizedError);
  });

  it('does not delegate to an excluded requester', async () => {
    const t = setup();
    const instance = await t.run(
      singleStepFlow({ approvers: [role('manager')], mode: 'any', excludeRequester: true }),
    );
    await expect(t.engine.delegate(instance.id, 'm1', 'u7')).rejects.toThrow(
      'The requester cannot approve in this group',
    );
  });
});

describe('cancel', () => {
  it('lets the requester cancel', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    const cancelled = await t.engine.cancel(instance.id, 'u7', 'No longer needed');
    expect(cancelled).toMatchObject({ status: 'cancelled', currentStepId: null });
    expect(cancelled.completedAt).toBeInstanceOf(Date);
    expect((await t.state(instance.id)).steps[0]?.status).toBe('cancelled');
    expect(await t.slots(instance.id)).toEqual({ default: ['s1:skipped'] });
    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]).toMatchObject({
      action: 'cancelled',
      actorId: 'u7',
      comment: 'No longer needed',
    });
    expect(t.events.slice(-1)[0]).toMatchObject({
      name: 'instance.completed',
      payload: { instance: { status: 'cancelled' } },
    });
  });

  it('lets an admin cancel, but nobody else', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await expect(t.engine.cancel(instance.id, 's1')).rejects.toThrow(NotAuthorizedError);
    expect((await t.engine.cancel(instance.id, 'admin')).status).toBe('cancelled');
  });

  it('cancels a returned instance', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await t.engine.returnForRevision(instance.id, 's1', 'x');
    expect((await t.engine.cancel(instance.id, 'u7')).status).toBe('cancelled');
  });

  it('refuses to cancel a finished instance', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await t.engine.cancel(instance.id, 'u7');
    await expect(t.engine.cancel(instance.id, 'u7')).rejects.toThrow(InvalidStateError);
  });

  it('has no admins unless isAdmin is configured', async () => {
    const t = setup({ isAdmin: undefined });
    const instance = await t.run(twoLevelFlow);
    await expect(t.engine.cancel(instance.id, 'admin')).rejects.toThrow(NotAuthorizedError);
  });
});

describe('reresolveApprovers', () => {
  const allDirectors = singleStepFlow({ approvers: [role('director')], mode: 'all' });

  it('replaces pending approvers and keeps decisions', async () => {
    const t = setup();
    const instance = await t.run(allDirectors);
    await t.engine.approve(instance.id, 'd1');
    t.roles.director = ['d3']; // d1 and d2 left the role, d3 joined
    const updated = await t.engine.reresolveApprovers(instance.id, 'admin');
    expect(updated.status).toBe('in_progress');
    expect(await t.slots(instance.id)).toEqual({ default: ['d1:approved', 'd3:pending'] });

    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]).toMatchObject({
      action: 'reresolved',
      actorId: 'admin',
      metadata: {
        added: [{ groupId: 'default', userId: 'd3' }],
        removed: [{ groupId: 'default', userId: 'd2' }],
      },
    });
    expect(t.eventNames().slice(-2)).toEqual(['approvers.reresolved', 'approval.required']);
    expect(t.events.slice(-1)[0]?.payload).toMatchObject({
      reason: 'reresolved',
      groups: [{ userIds: ['d3'] }],
    });
    expect((await t.engine.approve(instance.id, 'd3')).status).toBe('approved');
  });

  it('completes the step when the remaining decisions suffice', async () => {
    const t = setup();
    const instance = await t.run(allDirectors);
    await t.engine.approve(instance.id, 'd1');
    t.roles.director = ['d1'];
    expect((await t.engine.reresolveApprovers(instance.id, 'admin')).status).toBe('approved');
    const notified = t.events.filter(
      (event) =>
        event.name === 'approval.required' && (event.payload as any).reason === 'reresolved',
    );
    expect(notified).toEqual([]);
  });

  it('keeps delegations', async () => {
    const t = setup();
    const instance = await t.run(allDirectors);
    await t.engine.delegate(instance.id, 'd1', 'x1');
    await t.engine.reresolveApprovers(instance.id, 'admin');
    expect(await t.slots(instance.id)).toEqual({
      default: ['d1:delegated', 'd2:pending', 'x1:pending'],
    });
  });

  it('applies the insufficient-approvers policy to the new list', async () => {
    const t = setup();
    const flow = singleStepFlow({
      approvers: [role('committee')],
      mode: { minimum: 3 },
      onInsufficientApprovers: 'cap',
    });
    const instance = await t.run(flow);
    t.roles.committee = ['c1', 'c2'];
    await t.engine.reresolveApprovers(instance.id, 'admin');
    expect((await t.state(instance.id)).steps[0]?.config.groups[0]?.minimum).toBe(2);
  });

  it('fails like entering a step when the policy is "error"', async () => {
    const t = setup();
    const instance = await t.run(
      singleStepFlow({ approvers: [role('committee')], mode: { minimum: 3 } }),
    );
    t.roles.committee = ['c1'];
    await expect(t.engine.reresolveApprovers(instance.id, 'admin')).rejects.toThrow(
      InsufficientApproversError,
    );
    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]?.action).toBe('step_failed');
    expect(await t.slots(instance.id)).toEqual({
      default: ['c1:pending', 'c2:pending', 'c3:pending', 'c4:pending'],
    });
  });

  it('leaves decided groups alone', async () => {
    const t = setup();
    const flow = singleStepFlow({
      groups: [
        { id: 'mgr', approvers: [role('manager')], mode: 'any' },
        { id: 'fin', approvers: [role('finance')], mode: 'any' },
      ],
      countAcrossGroups: false,
    });
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 'm1');
    t.roles.manager = ['z1'];
    t.roles.finance = ['m2', 'f9'];
    await t.engine.reresolveApprovers(instance.id, 'admin');
    // m2 is still taken by "mgr" (countAcrossGroups false), so "fin" only gets f9.
    expect(await t.slots(instance.id)).toEqual({
      mgr: ['m1:approved', 'm2:skipped'],
      fin: ['f9:pending'],
    });
  });

  it('skips a group that became empty when the policy is "skip"', async () => {
    const t = setup();
    const flow = singleStepFlow({
      groups: [
        { id: 'mgr', approvers: [role('manager')], mode: 'any' },
        { id: 'legal', approvers: [role('director')], mode: 'any', onEmptyApprovers: 'skip' },
      ],
    });
    const instance = await t.run(flow);
    t.roles.director = [];
    await t.engine.reresolveApprovers(instance.id, 'admin');
    expect((await t.state(instance.id)).steps[0]?.config.groups[1]?.status).toBe('skipped');
    expect((await t.engine.approve(instance.id, 'm1')).status).toBe('approved');
  });

  it('is for admins only', async () => {
    const t = setup();
    const instance = await t.run(allDirectors);
    await expect(t.engine.reresolveApprovers(instance.id, 'd1')).rejects.toThrow(
      NotAuthorizedError,
    );
  });
});

describe('instance status', () => {
  it('stays pending until the first decision of a round', async () => {
    const t = setup();
    const flow = {
      ...twoLevelFlow,
      nodes: {
        ...twoLevelFlow.nodes,
        supervisor: { ...twoLevelFlow.nodes.supervisor, onEmptyApprovers: 'skip' },
      },
    } satisfies FlowDefinition;
    // ceo1 has no supervisor: the first level is skipped, which is not a decision.
    const instance = await t.run(flow, { requester: 'ceo1' });
    expect(instance.status).toBe('pending');
    expect(await t.activeNode(instance.id)).toBe('director');
  });
});
