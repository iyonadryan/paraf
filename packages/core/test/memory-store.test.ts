import { describe, expect, it } from 'vitest';
import {
  ActiveInstanceExistsError,
  FlowNotFoundError,
  FlowVersionExistsError,
  MemoryStore,
} from '../src';
import type { InstanceState } from '../src';
import { twoLevelFlow } from './fixtures/flows';

function instanceState(
  id: string,
  overrides: Partial<InstanceState['instance']> = {},
): InstanceState {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    instance: {
      id,
      flowId: 'purchase-request',
      flowVersion: 1,
      subject: { type: 'doc', id: id },
      requesterId: 'u1',
      status: 'pending',
      currentStepId: 'step-1',
      round: 1,
      document: {},
      revision: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      ...overrides,
    },
    steps: [
      {
        id: 'step-1',
        instanceId: id,
        nodeId: 'supervisor',
        iteration: 1,
        chainLevel: 0,
        round: 1,
        status: 'active',
        config: { require: 'all', countAcrossGroups: true, groups: [] },
        enteredAt: now,
        dueAt: new Date('2026-01-03T00:00:00Z'),
        completedAt: null,
      },
    ],
    approvers: [],
  };
}

describe('MemoryStore', () => {
  it('stores immutable flow versions', async () => {
    const store = new MemoryStore();
    await store.saveFlowVersion({ ...twoLevelFlow, version: 1 });
    await expect(store.saveFlowVersion({ ...twoLevelFlow, version: 1 })).rejects.toThrow(
      FlowVersionExistsError,
    );
    await store.saveFlowVersion({ ...twoLevelFlow, version: 2 });
    expect(await store.getActiveFlow('purchase-request')).toBeNull();
    await expect(store.setActiveVersion('purchase-request', 3)).rejects.toThrow(FlowNotFoundError);
    await store.setActiveVersion('purchase-request', 1);
    expect((await store.getActiveFlow('purchase-request'))?.version).toBe(1);
    expect((await store.getFlowVersion('purchase-request', 2))?.version).toBe(2);
  });

  it('keeps its data separate from callers', async () => {
    const store = new MemoryStore();
    const state = instanceState('a');
    await store.createInstance(state, []);
    state.instance.status = 'approved';
    const loaded = await store.getInstance('a');
    expect(loaded?.instance.status).toBe('pending');
    loaded!.steps[0]!.dueAt!.setFullYear(2000);
    expect((await store.getInstance('a'))?.steps[0]?.dueAt?.getFullYear()).toBe(2026);
    expect(await store.getInstance('missing')).toBeNull();
  });

  it('updates only at the expected revision', async () => {
    const store = new MemoryStore();
    await store.createInstance(instanceState('a'), []);
    const next = instanceState('a', { revision: 1, status: 'in_progress' });
    expect(await store.updateInstance(next, 1, [])).toBe(false);
    expect(await store.updateInstance(next, 0, [])).toBe(true);
    expect(await store.updateInstance(instanceState('missing', { revision: 1 }), 0, [])).toBe(
      false,
    );
  });

  it('enforces one active instance per subject on create and update', async () => {
    const store = new MemoryStore();
    await store.createInstance(instanceState('a', { subject: { type: 'doc', id: '1' } }), []);
    await expect(
      store.createInstance(instanceState('b', { subject: { type: 'doc', id: '1' } }), []),
    ).rejects.toThrow(ActiveInstanceExistsError);

    await store.createInstance(
      instanceState('c', { subject: { type: 'doc', id: '1' }, status: 'approved' }),
      [],
    );
    await expect(
      store.updateInstance(
        instanceState('c', { subject: { type: 'doc', id: '1' }, revision: 1 }),
        0,
        [],
      ),
    ).rejects.toThrow(ActiveInstanceExistsError);
  });

  it('lists flows by id with their latest and active versions', async () => {
    const store = new MemoryStore();
    // Saved out of order: the latest version is the highest number, not the last saved.
    await store.saveFlowVersion({ ...twoLevelFlow, id: 'b-flow', version: 2, name: 'B v2' });
    await store.saveFlowVersion({ ...twoLevelFlow, id: 'b-flow', version: 1 });
    await store.saveFlowVersion({ ...twoLevelFlow, id: 'a-flow', version: 1, name: 'A' });
    await store.setActiveVersion('b-flow', 1);
    expect(await store.listFlows()).toEqual([
      { id: 'a-flow', name: 'A', activeVersion: null, latestVersion: 1 },
      { id: 'b-flow', name: 'B v2', activeVersion: 1, latestVersion: 2 },
    ]);
  });

  it('orders instances created at the same time by id, newest id first', async () => {
    const store = new MemoryStore();
    for (const id of ['b', 'c', 'a']) await store.createInstance(instanceState(id), []);
    const found = await store.findInstances({});
    expect(found.items.map((instance) => instance.id)).toEqual(['c', 'b', 'a']);
  });

  it('includes the due date in the inbox', async () => {
    const store = new MemoryStore();
    const state = instanceState('a');
    state.approvers.push({
      id: 'slot-1',
      stepId: 'step-1',
      instanceId: 'a',
      groupId: 'default',
      userId: 'u2',
      source: null,
      status: 'pending',
      delegatedFrom: null,
      autoFromStep: null,
      decidedAt: null,
      comment: null,
    });
    await store.createInstance(state, []);
    const inbox = await store.findPendingForUser('u2');
    expect(inbox.items[0]?.dueAt).toEqual(new Date('2026-01-03T00:00:00Z'));
  });

  it('finds timed-out instances', async () => {
    const store = new MemoryStore();
    await store.createInstance(instanceState('a'), []);
    expect(await store.findTimedOut(new Date('2026-01-02T00:00:00Z'))).toEqual([]);
    expect(
      (await store.findTimedOut(new Date('2026-01-03T00:00:00Z'))).map((s) => s.instance.id),
    ).toEqual(['a']);
  });

  it('appends and reads audit entries per instance', async () => {
    const store = new MemoryStore();
    const entry = (id: string, instanceId: string) => ({
      id,
      instanceId,
      stepId: null,
      nodeId: null,
      action: 'started' as const,
      actorId: null,
      comment: null,
      timestamp: new Date(),
      metadata: null,
    });
    await store.createInstance(instanceState('a'), [entry('1', 'a')]);
    await store.appendAudit([entry('2', 'a'), entry('3', 'b')]);
    expect((await store.getAudit('a')).map((e) => e.id)).toEqual(['1', '2']);
  });
});
