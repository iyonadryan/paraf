import { describe, expect, it, vi } from 'vitest';
import {
  ChainCycleError,
  createEngine,
  EmptyApproversError,
  FlowValidationError,
  UnknownChainError,
} from '../../src';
import type { ChainResolver, FlowDefinition } from '../../src';
import { END_NODES, setup } from './helpers';
import type { Setup } from './helpers';

// Supervisors: u7 → s1 → m1 → d1 → ceo1. Directors: d1, d2.

function chainFlow(node: Record<string, unknown> = {}): FlowDefinition {
  return {
    id: 'chain',
    name: 'Chain',
    start: 'chain',
    nodes: {
      chain: {
        type: 'approval-chain',
        chain: 'supervisor',
        maxLevels: 5,
        next: 'approved',
        onReject: 'rejected',
        ...node,
      },
      ...END_NODES,
    },
  } as unknown as FlowDefinition;
}

const untilDirector = { until: { type: 'role', value: 'director' } };

async function chainEnd(t: Setup, instanceId: string) {
  return (await t.engine.getHistory(instanceId)).find((entry) => entry.action === 'chain_completed')
    ?.metadata;
}

async function levels(t: Setup, instanceId: string) {
  const state = await t.state(instanceId);
  return state.steps.map((step) => [
    step.chainLevel,
    state.approvers.find((slot) => slot.stepId === step.id)?.userId ?? null,
    step.status,
  ]);
}

describe('approval-chain: walking up', () => {
  it('creates one step per level until the director, one level at a time', async () => {
    const t = setup();
    const instance = await t.run(chainFlow(untilDirector));
    expect(await levels(t, instance.id)).toEqual([[1, 's1', 'active']]);
    expect((await t.engine.findPendingForUser('m1')).total).toBe(0);

    await t.engine.approve(instance.id, 's1');
    await t.engine.approve(instance.id, 'm1');
    const done = await t.engine.approve(instance.id, 'd1');
    expect(done.status).toBe('approved');
    expect(await levels(t, instance.id)).toEqual([
      [1, 's1', 'approved'],
      [2, 'm1', 'approved'],
      [3, 'd1', 'approved'],
    ]);

    const state = await t.state(instance.id);
    expect(state.steps.every((step) => step.iteration === 1 && step.nodeId === 'chain')).toBe(true);
    expect(state.steps.map((step) => step.config.chain)).toEqual([
      { fromUserId: 'u7', userId: 's1', stopper: false },
      { fromUserId: 's1', userId: 'm1', stopper: false },
      { fromUserId: 'm1', userId: 'd1', stopper: true },
    ]);
    expect(state.approvers[1]?.source).toEqual({ type: 'chain', chain: 'supervisor', level: 2 });
    expect(await chainEnd(t, instance.id)).toEqual({ reason: 'until', levels: 3 });
    const entered = (await t.engine.getHistory(instance.id)).filter(
      (e) => e.action === 'step_entered',
    );
    expect(entered[1]?.metadata).toEqual({
      iteration: 1,
      level: 2,
      groups: [{ groupId: 'default', approvers: ['m1'] }],
    });
  });

  it.each([
    ['m1', ['d1']],
    ['s1', ['m1', 'd1']],
    ['u7', ['s1', 'm1', 'd1']],
  ])('has a depth that depends on the requester (%s)', async (requester, expected) => {
    const t = setup();
    const instance = await t.run(chainFlow(untilDirector), { requester });
    for (const user of expected) await t.engine.approve(instance.id, user);
    expect((await t.state(instance.id)).instance.status).toBe('approved');
    expect((await levels(t, instance.id)).map(([, user]) => user)).toEqual(expected);
  });

  it('includeStopper false stops below the director', async () => {
    const t = setup();
    const instance = await t.run(chainFlow({ ...untilDirector, includeStopper: false }));
    await t.engine.approve(instance.id, 's1');
    expect((await t.engine.approve(instance.id, 'm1')).status).toBe('approved');
    expect((await levels(t, instance.id)).map(([, user]) => user)).toEqual(['s1', 'm1']);
    expect(await chainEnd(t, instance.id)).toEqual({ reason: 'until', levels: 2 });
  });

  it('includeStopper false approves without steps when the first level is the stopper', async () => {
    const t = setup();
    const instance = await t.run(chainFlow({ ...untilDirector, includeStopper: false }), {
      requester: 'm1',
    });
    expect(instance.status).toBe('approved');
    expect((await t.state(instance.id)).steps).toEqual([]);
    expect(await chainEnd(t, instance.id)).toEqual({ reason: 'until', levels: 0 });
  });

  it('without until, walks to the top of the chain', async () => {
    const t = setup();
    const instance = await t.run(chainFlow());
    for (const user of ['s1', 'm1', 'd1', 'ceo1']) await t.engine.approve(instance.id, user);
    expect((await t.state(instance.id)).instance.status).toBe('approved');
    expect(await chainEnd(t, instance.id)).toEqual({ reason: 'top', levels: 4 });
  });

  it('continues to next after maxLevels and records it', async () => {
    const t = setup();
    const instance = await t.run(
      chainFlow({ until: { type: 'role', value: 'ceo' }, maxLevels: 2 }),
    );
    await t.engine.approve(instance.id, 's1');
    expect((await t.engine.approve(instance.id, 'm1')).status).toBe('approved');
    expect(await chainEnd(t, instance.id)).toEqual({ reason: 'max_levels', levels: 2 });
  });

  it('runs the onReject path when any level rejects', async () => {
    const t = setup();
    const instance = await t.run(chainFlow(untilDirector));
    await t.engine.approve(instance.id, 's1');
    expect((await t.engine.reject(instance.id, 'm1', 'Over budget')).status).toBe('rejected');
    expect((await levels(t, instance.id)).map(([, user]) => user)).toEqual(['s1', 'm1']);
    expect(await chainEnd(t, instance.id)).toBeUndefined();
  });

  it('starts from a user in the document', async () => {
    const t = setup();
    const instance = await t.run(chainFlow({ ...untilDirector, from: { field: 'pic' } }), {
      document: { pic: 'm1' },
    });
    expect(await levels(t, instance.id)).toEqual([[1, 'd1', 'active']]);
  });

  it('notifies each level when it is reached', async () => {
    const t = setup();
    const instance = await t.run(chainFlow(untilDirector));
    await t.engine.approve(instance.id, 's1');
    const required = t.events
      .filter((event) => event.name === 'approval.required')
      .map((event) => (event.payload as { groups: { userIds: string[] }[] }).groups[0]?.userIds);
    expect(required).toEqual([['s1'], ['m1']]);
  });

  it('gives the resolver the level and the instance', async () => {
    const t = setup();
    const resolver = vi.fn<ChainResolver>((from) => (from === 'u7' ? 's1' : null));
    t.engine.registerChain('spy', resolver);
    const instance = await t.run(chainFlow({ chain: 'spy' }), { document: { amount: 5 } });
    await t.engine.approve(instance.id, 's1');
    expect(resolver.mock.calls.map(([from, context]) => [from, context.level])).toEqual([
      ['u7', 1],
      ['s1', 2],
    ]);
    expect(resolver.mock.calls[0]?.[1]).toMatchObject({
      requester: { id: 'u7' },
      subject: { type: 'doc', id: '1' },
      document: { amount: 5 },
      nodeId: 'chain',
    });
  });

  it('lets a level delegate; the chain continues above the original approver', async () => {
    const t = setup();
    const instance = await t.run(chainFlow(untilDirector));
    await t.engine.delegate(instance.id, 's1', 'x9');
    await t.engine.approve(instance.id, 'x9');
    expect(await levels(t, instance.id)).toEqual([
      [1, 's1', 'approved'],
      [2, 'm1', 'active'],
    ]);
  });
});

describe('approval-chain: requester handling', () => {
  it('skips the level of an excluded requester and continues above them', async () => {
    const t = setup();
    t.supervisors.x1 = 'm1';
    const instance = await t.run(
      chainFlow({ ...untilDirector, from: { field: 'pic' }, excludeRequester: true }),
      { requester: 'm1', document: { pic: 'x1' } },
    );
    expect(await levels(t, instance.id)).toEqual([
      [1, null, 'skipped'],
      [2, 'd1', 'active'],
    ]);
    const skipped = (await t.engine.getHistory(instance.id)).find((e) => e.action === 'skipped');
    expect(skipped?.metadata).toEqual({ level: 1, userId: 'm1', reason: 'requester' });
  });

  it('ends the chain when the excluded requester is the stopper', async () => {
    const t = setup();
    t.supervisors.x1 = 'd1';
    const instance = await t.run(
      chainFlow({ ...untilDirector, from: { field: 'pic' }, excludeRequester: true }),
      { requester: 'd1', document: { pic: 'x1' } },
    );
    expect(instance.status).toBe('approved');
    expect(await chainEnd(t, instance.id)).toEqual({ reason: 'until', levels: 1 });
  });
});

describe('approval-chain: empty chains', () => {
  // ceo1 has no supervisor.
  it('fails by default', async () => {
    const t = setup();
    const error = await t
      .run(chainFlow(), { requester: 'ceo1' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmptyApproversError);
    expect(error).toMatchObject({ context: { nodeId: 'chain', groupId: 'default' } });
  });

  it('can be skipped', async () => {
    const t = setup();
    const instance = await t.run(chainFlow({ onEmptyApprovers: 'skip' }), { requester: 'ceo1' });
    expect(instance.status).toBe('approved');
    const skipped = (await t.engine.getHistory(instance.id)).find((e) => e.action === 'skipped');
    expect(skipped).toMatchObject({ nodeId: 'chain', metadata: { reason: 'empty_chain' } });
  });

  it('can use fallback approvers', async () => {
    const t = setup();
    const flow = chainFlow({
      onEmptyApprovers: 'fallback',
      fallbackApprovers: [{ type: 'role', value: 'director' }],
    });
    const instance = await t.run(flow, { requester: 'ceo1' });
    expect(await t.slots(instance.id)).toEqual({ default: ['d1:pending', 'd2:pending'] });
    expect((await t.state(instance.id)).steps[0]).toMatchObject({ chainLevel: 1 });
    expect((await t.state(instance.id)).steps[0]?.config.chain).toBeUndefined();
    expect((await t.engine.approve(instance.id, 'd2')).status).toBe('approved');
    expect(await chainEnd(t, instance.id)).toEqual({ reason: 'fallback', levels: 1 });
  });

  it('fails when the fallback is empty too', async () => {
    const t = setup();
    const flow = chainFlow({
      onEmptyApprovers: 'fallback',
      fallbackApprovers: [{ type: 'role', value: 'nobody' }],
    });
    await expect(t.run(flow, { requester: 'ceo1' })).rejects.toThrow(EmptyApproversError);
  });

  it('treats a missing document field as an empty chain', async () => {
    const t = setup();
    const flow = chainFlow({ from: { field: 'pic' }, onEmptyApprovers: 'skip' });
    expect((await t.run(flow)).status).toBe('approved');
  });
});

describe('approval-chain: errors', () => {
  it('detects a cycle as soon as the chain repeats a user', async () => {
    const t = setup();
    const loop: Record<string, string> = { a: 'b', b: 'a' };
    t.engine.registerChain('loop', (from) => loop[from] ?? null);
    const instance = await t.run(chainFlow({ chain: 'loop' }), { requester: 'a' });
    const error = await t.engine.approve(instance.id, 'b').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChainCycleError);
    expect(error).toMatchObject({ code: 'CHAIN_CYCLE', path: ['a', 'b', 'a'] });
    expect((error as Error).message).toContain('a → b → a');
    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]).toMatchObject({
      action: 'step_failed',
      metadata: { code: 'CHAIN_CYCLE' },
    });
  });

  it('detects a user who is their own supervisor', async () => {
    const t = setup();
    t.engine.registerChain('self', (from) => from);
    await expect(t.run(chainFlow({ chain: 'self' }))).rejects.toThrow(ChainCycleError);
  });

  it('requires the chain to be registered when publishing', async () => {
    const t = setup();
    const error = await t.engine.publishFlow(chainFlow({ chain: 'hr' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowValidationError);
    expect((error as FlowValidationError).issues[0]?.code).toBe('UNKNOWN_CHAIN');
  });

  it('fails clearly when the chain is not registered at runtime', async () => {
    const t = setup();
    await t.publish(chainFlow());
    const bare = createEngine({ store: t.store });
    await expect(
      bare.start('chain', { subject: { type: 'doc', id: '1' }, requester: { id: 'u7' } }),
    ).rejects.toThrow(UnknownChainError);
  });

  it('lists chains for the editor and rejects nameless ones', () => {
    const t = setup();
    t.engine.registerChain('hr', () => null);
    expect(t.engine.getChains()).toEqual([
      { name: 'supervisor', label: 'Supervisors' },
      { name: 'hr', label: 'hr' },
    ]);
    expect(() => {
      t.engine.registerChain('', () => null);
    }).toThrow(TypeError);
  });
});

describe('approval-chain: reresolveApprovers', () => {
  it('replaces the level approver when the supervisor changed', async () => {
    const t = setup();
    const instance = await t.run(chainFlow(untilDirector));
    t.supervisors.u7 = 's2';
    await t.engine.reresolveApprovers(instance.id, 'admin');
    expect(await t.slots(instance.id)).toEqual({ default: ['s2:pending'] });
    expect((await t.state(instance.id)).steps[0]?.config.chain?.userId).toBe('s2');
    expect((await t.engine.getHistory(instance.id)).slice(-1)[0]?.metadata).toEqual({
      added: [{ groupId: 'default', userId: 's2' }],
      removed: [{ groupId: 'default', userId: 's1' }],
    });
    // s2 has no supervisor: the chain ends at the top after s2.
    expect((await t.engine.approve(instance.id, 's2')).status).toBe('approved');
    expect(await chainEnd(t, instance.id)).toEqual({ reason: 'top', levels: 1 });
  });

  it('keeps the level when nothing changed', async () => {
    const t = setup();
    const instance = await t.run(chainFlow(untilDirector));
    expect((await t.engine.reresolveApprovers(instance.id, 'admin')).status).toBe('pending');
    expect(await t.slots(instance.id)).toEqual({ default: ['s1:pending'] });
  });

  it('keeps a delegate', async () => {
    const t = setup();
    const instance = await t.run(chainFlow(untilDirector));
    await t.engine.delegate(instance.id, 's1', 'x9');
    t.supervisors.u7 = 's2';
    await t.engine.reresolveApprovers(instance.id, 'admin');
    expect(await t.slots(instance.id)).toEqual({
      default: ['s1:delegated', 'x9:pending', 's2:pending'],
    });
  });

  it('ends the chain when the level has no approver anymore', async () => {
    const t = setup();
    const instance = await t.run(chainFlow(untilDirector));
    await t.engine.approve(instance.id, 's1');
    t.supervisors.s1 = undefined;
    const updated = await t.engine.reresolveApprovers(instance.id, 'admin');
    expect(updated.status).toBe('approved');
    expect(await levels(t, instance.id)).toEqual([
      [1, 's1', 'approved'],
      [2, null, 'skipped'],
    ]);
    expect(await chainEnd(t, instance.id)).toEqual({ reason: 'top', levels: 1 });
  });

  it('makes the new approver the last level when they match until', async () => {
    const t = setup();
    const instance = await t.run(chainFlow(untilDirector));
    t.supervisors.u7 = 'd2';
    await t.engine.reresolveApprovers(instance.id, 'admin');
    expect(await t.slots(instance.id)).toEqual({ default: ['d2:pending'] });
    expect((await t.state(instance.id)).steps[0]?.config.chain).toEqual({
      fromUserId: 'u7',
      userId: 'd2',
      stopper: true,
    });
    expect((await t.engine.approve(instance.id, 'd2')).status).toBe('approved');
    expect(await chainEnd(t, instance.id)).toEqual({ reason: 'until', levels: 1 });
  });

  it('ends the chain when the new approver is an excluded stopper', async () => {
    const t = setup();
    const instance = await t.run(chainFlow({ ...untilDirector, includeStopper: false }));
    t.supervisors.u7 = 'd2';
    expect((await t.engine.reresolveApprovers(instance.id, 'admin')).status).toBe('approved');
    expect(await chainEnd(t, instance.id)).toEqual({ reason: 'until', levels: 0 });
  });

  it('skips a level that now belongs to the excluded requester', async () => {
    const t = setup();
    t.supervisors.x1 = 's1';
    const instance = await t.run(
      chainFlow({ ...untilDirector, from: { field: 'pic' }, excludeRequester: true }),
      { requester: 'm1', document: { pic: 'x1' } },
    );
    t.supervisors.x1 = 'm1';
    await t.engine.reresolveApprovers(instance.id, 'admin');
    expect(await levels(t, instance.id)).toEqual([
      [1, null, 'skipped'],
      [2, 'd1', 'active'],
    ]);
  });

  it('re-resolves fallback approvers', async () => {
    const t = setup();
    const flow = chainFlow({
      onEmptyApprovers: 'fallback',
      fallbackApprovers: [{ type: 'role', value: 'director' }],
    });
    const instance = await t.run(flow, { requester: 'ceo1' });
    t.roles.director = ['d3'];
    await t.engine.reresolveApprovers(instance.id, 'admin');
    expect(await t.slots(instance.id)).toEqual({ default: ['d3:pending'] });
  });
});

describe('approval-chain in a larger flow', () => {
  it('is followed by other nodes and can be revisited after a return', async () => {
    const t = setup();
    const flow = {
      id: 'mixed',
      name: 'Mixed',
      start: 'chain',
      nodes: {
        chain: {
          type: 'approval-chain',
          chain: 'supervisor',
          until: { type: 'role', value: 'manager' },
          maxLevels: 3,
          next: 'finance',
          onReject: 'rejected',
        },
        finance: {
          type: 'approval',
          approvers: [{ type: 'role', value: 'finance' }],
          mode: 'any',
          next: 'approved',
          onReject: 'rejected',
        },
        ...END_NODES,
      },
    } satisfies FlowDefinition;
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 's1');
    await t.engine.approve(instance.id, 'm1');
    expect(await t.activeNode(instance.id)).toBe('finance');
    await t.engine.returnForRevision(instance.id, 'f1', 'recheck', { toNodeId: 'chain' });
    const state = await t.state(instance.id);
    expect(state.steps.slice(-1)[0]).toMatchObject({
      nodeId: 'chain',
      iteration: 2,
      chainLevel: 1,
    });
    await t.engine.approve(instance.id, 's1');
    await t.engine.approve(instance.id, 'm1');
    expect((await t.engine.approve(instance.id, 'f2')).status).toBe('approved');
  });
});
