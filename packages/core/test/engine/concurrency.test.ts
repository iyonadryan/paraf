import { describe, expect, it, vi } from 'vitest';
import { ConcurrencyError, InvalidStateError, MemoryStore } from '../../src';
import type { AuditEntry, InstanceState } from '../../src';
import { setup, singleStepFlow } from './helpers';

/**
 * A MemoryStore whose writes wait for the event loop, so actions started together all read the
 * same revision before the first one saves.
 */
class SlowStore extends MemoryStore {
  conflicts = 0;

  override async updateInstance(
    state: InstanceState,
    expectedRevision: number,
    audit: AuditEntry[],
  ): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saved = await super.updateInstance(state, expectedRevision, audit);
    if (!saved) this.conflicts++;
    return saved;
  }
}

const role = (value: string) => ({ type: 'role', value });

describe('concurrent approvals', () => {
  it('mode "all": both approvals count exactly once', async () => {
    const store = new SlowStore();
    const t = setup({ store });
    const instance = await t.run(singleStepFlow({ approvers: [role('director')], mode: 'all' }));

    await Promise.all([t.engine.approve(instance.id, 'd1'), t.engine.approve(instance.id, 'd2')]);

    expect(store.conflicts).toBeGreaterThan(0);
    const state = await t.state(instance.id);
    expect(state.instance.status).toBe('approved');
    expect(await t.slots(instance.id)).toEqual({ default: ['d1:approved', 'd2:approved'] });
    const approvals = (await t.engine.getHistory(instance.id)).filter(
      (entry) => entry.action === 'approved',
    );
    expect(approvals.map((entry) => entry.actorId).sort()).toEqual(['d1', 'd2']);
    expect(t.eventNames().filter((name) => name === 'instance.completed')).toHaveLength(1);
  });

  it('mode { minimum: 2 }: a late third approver finds the instance finished', async () => {
    const store = new SlowStore();
    const t = setup({ store });
    const instance = await t.run(
      singleStepFlow({ approvers: [role('committee')], mode: { minimum: 2 } }),
    );

    const results = await Promise.allSettled(
      ['c1', 'c2', 'c3'].map((user) => t.engine.approve(instance.id, user)),
    );

    expect(store.conflicts).toBeGreaterThan(0);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const failed = results.find((result) => result.status === 'rejected');
    expect((failed as PromiseRejectedResult).reason).toBeInstanceOf(InvalidStateError);
    const state = await t.state(instance.id);
    expect(state.instance.status).toBe('approved');
    expect(state.approvers.filter((slot) => slot.status === 'approved')).toHaveLength(2);
  });

  it('parallel groups: concurrent approvals across groups', async () => {
    const store = new SlowStore();
    const t = setup({ store });
    const flow = singleStepFlow({
      groups: [
        { id: 'mgr', approvers: [role('manager')], mode: 'any' },
        { id: 'fin', approvers: [role('finance')], mode: { minimum: 2 } },
      ],
    });
    const instance = await t.run(flow);

    await Promise.all(['m1', 'f1', 'f2'].map((user) => t.engine.approve(instance.id, user)));

    expect(store.conflicts).toBeGreaterThan(0);
    expect((await t.state(instance.id)).instance).toMatchObject({
      status: 'approved',
      revision: 3,
    });
    expect(await t.slots(instance.id)).toEqual({
      mgr: ['m1:approved', 'm2:skipped'],
      fin: ['f1:approved', 'f2:approved', 'f3:skipped'],
    });
  });

  it('gives up with ConcurrencyError after the configured retries', async () => {
    const store = new MemoryStore();
    const t = setup({ store, maxRetries: 2 });
    const instance = await t.run(singleStepFlow({ approvers: [role('director')], mode: 'all' }));
    const update = vi.spyOn(store, 'updateInstance').mockResolvedValue(false);

    const error = await t.engine.approve(instance.id, 'd1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConcurrencyError);
    expect(error).toMatchObject({
      attempts: 3,
      context: { action: 'approve', instanceId: instance.id },
    });
    expect(update).toHaveBeenCalledTimes(3);
  });
});
