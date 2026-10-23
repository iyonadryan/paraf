import { describe, expect, it } from 'vitest';
import { setup, singleStepFlow } from './helpers';

const role = (value: string) => ({ type: 'role', value });
const users = (...ids: string[]) => ({ type: 'user', value: ids });

/** "At least 1 manager and at least 2 from finance". */
const managerAndFinance = (extra: Record<string, unknown> = {}) =>
  singleStepFlow({
    groups: [
      { id: 'mgr', label: 'Manager', approvers: [role('manager')], mode: 'any' },
      { id: 'fin', label: 'Finance', approvers: [role('finance')], mode: { minimum: 2 } },
    ],
    ...extra,
  });

describe('parallel groups', () => {
  it('notifies every group at once', async () => {
    const t = setup();
    await t.run(managerAndFinance());
    const required = t.events.find((event) => event.name === 'approval.required');
    expect(required?.payload).toMatchObject({
      groups: [
        { groupId: 'mgr', label: 'Manager', userIds: ['m1', 'm2'] },
        { groupId: 'fin', label: 'Finance', userIds: ['f1', 'f2', 'f3'] },
      ],
    });
  });

  it('require "all" waits for every group', async () => {
    const t = setup();
    const instance = await t.run(managerAndFinance());
    await t.engine.approve(instance.id, 'f1');
    await t.engine.approve(instance.id, 'm1');
    expect(await t.activeNode(instance.id)).toBe('step');
    expect((await t.engine.approve(instance.id, 'f3')).status).toBe('approved');
  });

  it('skips the pending approvers of a group as soon as it is decided', async () => {
    const t = setup();
    const instance = await t.run(managerAndFinance());
    await t.engine.approve(instance.id, 'm1');
    expect(await t.slots(instance.id)).toEqual({
      mgr: ['m1:approved', 'm2:skipped'],
      fin: ['f1:pending', 'f2:pending', 'f3:pending'],
    });
    expect((await t.engine.findPendingForUser('m2')).total).toBe(0);
    const state = await t.state(instance.id);
    expect(state.steps[0]?.config.groups.map((group) => group.status)).toEqual([
      'approved',
      'pending',
    ]);
  });

  it('require "all" rejects the node when one group fails', async () => {
    const t = setup();
    const instance = await t.run(managerAndFinance());
    await t.engine.approve(instance.id, 'f1');
    expect((await t.engine.reject(instance.id, 'm1', 'no')).status).toBe('rejected');
  });

  it('require "any" is satisfied by one group', async () => {
    const t = setup();
    const instance = await t.run(managerAndFinance({ require: 'any' }));
    expect((await t.engine.approve(instance.id, 'm2')).status).toBe('approved');
    expect(await t.slots(instance.id)).toEqual({
      mgr: ['m1:skipped', 'm2:approved'],
      fin: ['f1:skipped', 'f2:skipped', 'f3:skipped'],
    });
  });

  it('require "any" rejects only when no group can succeed', async () => {
    const t = setup();
    const instance = await t.run(managerAndFinance({ require: 'any' }));
    expect((await t.engine.reject(instance.id, 'm1', 'no')).status).toBe('in_progress');
    await t.engine.reject(instance.id, 'f1', 'no');
    expect((await t.engine.reject(instance.id, 'f2', 'no')).status).toBe('rejected');
  });

  it('require { minimum: 2 } needs two of three groups', async () => {
    const t = setup();
    const flow = singleStepFlow({
      groups: [
        { id: 'a', approvers: [users('a1')], mode: 'any' },
        { id: 'b', approvers: [users('b1')], mode: 'any' },
        { id: 'c', approvers: [users('c1')], mode: 'any' },
      ],
      require: { minimum: 2 },
    });
    const first = await t.run(flow);
    await t.engine.approve(first.id, 'a1');
    expect((await t.engine.approve(first.id, 'c1')).status).toBe('approved');

    const second = await t.run(flow, { subjectId: '2' });
    await t.engine.reject(second.id, 'a1', 'no');
    expect((await t.engine.approve(second.id, 'b1')).status).toBe('in_progress');
    expect((await t.engine.reject(second.id, 'c1', 'no')).status).toBe('rejected');
  });

  it('counts a skipped (empty) group as satisfied and records it', async () => {
    const t = setup();
    const flow = singleStepFlow({
      groups: [
        { id: 'mgr', approvers: [role('manager')], mode: 'any' },
        { id: 'legal', approvers: [role('legal')], mode: 'any', onEmptyApprovers: 'skip' },
      ],
    });
    const instance = await t.run(flow);
    const skipped = (await t.engine.getHistory(instance.id)).find(
      (entry) => entry.action === 'skipped',
    );
    expect(skipped).toMatchObject({
      nodeId: 'step',
      metadata: { groupId: 'legal', reason: 'no_approvers' },
    });
    expect((await t.engine.approve(instance.id, 'm1')).status).toBe('approved');
    expect((await t.state(instance.id)).steps[0]?.status).toBe('approved');
  });
});

describe('a user in several groups', () => {
  const flow = (countAcrossGroups?: boolean) =>
    singleStepFlow({
      groups: [
        { id: 'mgr', approvers: [role('manager')], mode: 'any' },
        { id: 'pic', approvers: [users('m1', 'x1')], mode: 'all' },
      ],
      ...(countAcrossGroups === undefined ? {} : { countAcrossGroups }),
    });

  it('counts one decision in every group by default', async () => {
    const t = setup();
    const instance = await t.run(flow());
    expect(await t.slots(instance.id)).toEqual({
      mgr: ['m1:pending', 'm2:pending'],
      pic: ['m1:pending', 'x1:pending'],
    });
    await t.engine.approve(instance.id, 'm1');
    expect(await t.slots(instance.id)).toEqual({
      mgr: ['m1:approved', 'm2:skipped'],
      pic: ['m1:approved', 'x1:pending'],
    });
    const approved = (await t.engine.getHistory(instance.id)).find(
      (entry) => entry.action === 'approved',
    );
    expect(approved?.metadata).toEqual({ groupIds: ['mgr', 'pic'] });
    expect((await t.engine.approve(instance.id, 'x1')).status).toBe('approved');
  });

  it('with countAcrossGroups false, keeps the user only in the first group', async () => {
    const t = setup();
    const instance = await t.run(flow(false));
    expect(await t.slots(instance.id)).toEqual({
      mgr: ['m1:pending', 'm2:pending'],
      pic: ['x1:pending'],
    });
    await t.engine.approve(instance.id, 'm1');
    expect(await t.activeNode(instance.id)).toBe('step');
    expect((await t.engine.approve(instance.id, 'x1')).status).toBe('approved');
  });

  it('lists every group of the user in the inbox', async () => {
    const t = setup();
    await t.run(flow());
    const inbox = await t.engine.findPendingForUser('m1');
    expect(inbox.items[0]).toMatchObject({ nodeId: 'step', groupIds: ['mgr', 'pic'] });
  });
});
