import { describe, expect, it } from 'vitest';
import { EmptyApproversError, InvalidStateError, ParafError } from '../../src';
import type { PublishedFlow } from '../../src';
import { END_NODES, setup, singleStepFlow, twoLevelFlow } from './helpers';
import type { Setup } from './helpers';

/** Stores a flow directly, skipping the validation `publishFlow` does. */
async function storeUnvalidated(t: Setup, flow: Record<string, unknown>): Promise<void> {
  await t.store.saveFlowVersion({ version: 1, ...flow } as unknown as PublishedFlow);
  await t.store.setActiveVersion(flow.id as string, 1);
}

/** Rewrites an instance in the store, as a faulty migration or manual edit could. */
async function tamper(t: Setup, instanceId: string, change: (state: any) => void): Promise<void> {
  const state = await t.state(instanceId);
  change(state);
  await t.store.updateInstance(state, state.instance.revision, []);
}

describe('flows stored without validation', () => {
  it('treats a non-string field path as resolving nobody', async () => {
    const t = setup();
    await storeUnvalidated(
      t,
      singleStepFlow({ approvers: [{ type: 'field', value: 5 }], mode: 'any' }) as never,
    );
    await expect(
      t.engine.start('single', { subject: { type: 'doc', id: '1' }, requester: { id: 'u7' } }),
    ).rejects.toThrow(EmptyApproversError);
  });

  it('treats a missing fallback list as empty', async () => {
    const t = setup();
    const flow = singleStepFlow({
      approvers: [{ type: 'role', value: 'nobody' }],
      mode: 'any',
      onEmptyApprovers: 'fallback',
    });
    await storeUnvalidated(t, flow as never);
    await expect(
      t.engine.start('single', { subject: { type: 'doc', id: '1' }, requester: { id: 'u7' } }),
    ).rejects.toThrow(EmptyApproversError);
  });

  it('treats a missing fallback list of an approval chain as empty', async () => {
    const t = setup();
    await storeUnvalidated(t, {
      id: 'chain',
      name: 'Chain',
      start: 'chain',
      nodes: {
        chain: {
          type: 'approval-chain',
          chain: 'supervisor',
          maxLevels: 3,
          onEmptyApprovers: 'fallback',
          next: 'approved',
          onReject: 'rejected',
        },
        ...END_NODES,
      },
    });
    // ceo1 has no supervisor, so the chain is empty and the (missing) fallback is used.
    await expect(
      t.engine.start('chain', { subject: { type: 'doc', id: '1' }, requester: { id: 'ceo1' } }),
    ).rejects.toThrow(EmptyApproversError);
  });

  it('ignores a timeout whose duration cannot be parsed', async () => {
    const t = setup();
    await storeUnvalidated(
      t,
      singleStepFlow({
        approvers: [{ type: 'user', value: 'x1' }],
        mode: 'any',
        timeout: { after: 'three days', action: 'escalate', to: [{ type: 'user', value: 'x2' }] },
      }) as never,
    );
    const instance = await t.engine.start('single', {
      subject: { type: 'doc', id: '1' },
      requester: { id: 'u7' },
    });
    expect((await t.state(instance.id)).steps[0]?.dueAt).toBeNull();
  });

  it('reports a reference to a missing node', async () => {
    const t = setup();
    await storeUnvalidated(t, {
      id: 'broken',
      name: 'Broken',
      start: 'ghost',
      nodes: { ...END_NODES },
    });
    const error = await t.engine
      .start('broken', { subject: { type: 'doc', id: '1' }, requester: { id: 'u7' } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ParafError);
    expect(error).toMatchObject({
      code: 'UNKNOWN_NODE',
      message: 'Flow "broken" has no node "ghost".',
    });
  });
});

describe('inconsistent instance state', () => {
  it('refuses to resubmit without a returned step', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await t.engine.returnForRevision(instance.id, 's1', 'x');
    await tamper(t, instance.id, (state) => {
      state.steps[0].status = 'cancelled';
    });
    await expect(t.engine.resubmit(instance.id, 'u7')).rejects.toThrow(
      new InvalidStateError('No returned step to resume from', {
        action: 'resubmit',
        instanceId: instance.id,
        userId: 'u7',
      }),
    );
  });

  it('restarts when the returned step has no resubmit policy', async () => {
    const t = setup();
    const instance = await t.run({ ...twoLevelFlow, resubmitPolicy: 'resume' });
    await t.engine.approve(instance.id, 's1');
    await t.engine.returnForRevision(instance.id, 'd1', 'x');
    await tamper(t, instance.id, (state) => {
      delete state.steps[1].config.resubmitPolicy;
    });
    await t.engine.resubmit(instance.id, 'u7');
    expect(await t.activeNode(instance.id)).toBe('supervisor');
  });

  it('escalates to nobody when a due step belongs to a node without timeout', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await tamper(t, instance.id, (state) => {
      state.steps[0].dueAt = new Date('2026-01-01T00:00:00Z');
    });
    const result = await t.engine.processTimeouts(new Date('2026-01-02T00:00:00Z'));
    expect(result.escalated).toHaveLength(1);
    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]?.metadata).toMatchObject({
      approvers: [],
    });
  });

  it('refuses to continue a step whose node is not an approval node', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await tamper(t, instance.id, (state) => {
      state.steps[0].nodeId = 'approved';
    });
    const error = await t.engine.approve(instance.id, 's1').catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'UNKNOWN_NODE',
      message: 'Node "approved" is not an approval node.',
    });
  });

  it('refuses a slot that belongs to no group of its step', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    await tamper(t, instance.id, (state) => {
      state.approvers[0].groupId = 'ghost';
    });
    const error = await t.engine
      .delegate(instance.id, 's1', 'x1')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'UNKNOWN_GROUP', message: 'Step has no group "ghost".' });
  });
});
