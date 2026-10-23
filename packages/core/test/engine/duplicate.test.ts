import { describe, expect, it } from 'vitest';
import type { FlowDefinition } from '../../src';
import { END_NODES, setup } from './helpers';
import type { Setup } from './helpers';

const users = (...ids: string[]) => [{ type: 'user', value: ids }];

/** Approval nodes `l1`, `l2`, ... in sequence, each built from the given node fields. */
function levelsFlow(...levels: Record<string, unknown>[]): FlowDefinition {
  const nodes: Record<string, unknown> = { ...END_NODES };
  levels.forEach((level, index) => {
    nodes[`l${index + 1}`] = {
      type: 'approval',
      ...('groups' in level ? {} : { mode: 'any' }),
      next: index + 1 < levels.length ? `l${index + 2}` : 'approved',
      onReject: 'rejected',
      ...level,
    };
  });
  return { id: 'levels', name: 'Levels', start: 'l1', nodes } as unknown as FlowDefinition;
}

const auto = { duplicateApprover: 'auto-approve' } as const;

async function autoEntries(t: Setup, instanceId: string) {
  return (await t.engine.getHistory(instanceId)).filter(
    (entry) => entry.action === 'auto_approved',
  );
}

describe('duplicateApprover', () => {
  it('"require" (default) asks the same person again', async () => {
    const t = setup();
    const instance = await t.run(
      levelsFlow({ approvers: users('m1') }, { approvers: users('m1') }),
    );
    await t.engine.approve(instance.id, 'm1');
    expect(await t.activeNode(instance.id)).toBe('l2');
    expect((await t.engine.approve(instance.id, 'm1')).status).toBe('approved');
  });

  it('"auto-approve" approves a user who approved an earlier level', async () => {
    const t = setup();
    const flow = levelsFlow(
      { approvers: users('m1') },
      { approvers: users('m1', 'm2'), mode: 'all', ...auto },
    );
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 'm1');

    const state = await t.state(instance.id);
    const [first, second] = state.steps;
    const slot = state.approvers.find((s) => s.stepId === second?.id && s.userId === 'm1');
    expect(slot).toMatchObject({ status: 'approved', autoFromStep: first?.id, comment: null });
    expect(slot?.decidedAt).toBeInstanceOf(Date);
    expect(await autoEntries(t, instance.id)).toEqual([
      expect.objectContaining({
        actorId: null,
        stepId: second?.id,
        metadata: { userId: 'm1', groupIds: ['default'], fromStepId: first?.id },
      }),
    ]);
    const required = t.events.filter((event) => event.name === 'approval.required').slice(-1)[0];
    expect(required?.payload).toMatchObject({ groups: [{ userIds: ['m2'] }] });
    expect((await t.engine.approve(instance.id, 'm2')).status).toBe('approved');
  });

  it('completes a level that only has duplicate approvers', async () => {
    const t = setup();
    const flow = levelsFlow({ approvers: users('m1') }, { approvers: users('m1'), ...auto });
    const instance = await t.run(flow);
    expect((await t.engine.approve(instance.id, 'm1')).status).toBe('approved');
  });

  it('refers to the original decision across several levels', async () => {
    const t = setup();
    const flow = levelsFlow(
      { approvers: users('m1') },
      { approvers: users('m1'), ...auto },
      { approvers: users('m1', 'd1'), mode: 'all', ...auto },
    );
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 'm1');
    const firstStep = (await t.state(instance.id)).steps[0]?.id;
    expect((await autoEntries(t, instance.id)).map((entry) => entry.metadata?.fromStepId)).toEqual([
      firstStep,
      firstStep,
    ]);
  });

  it('auto-approves every group of the user', async () => {
    const t = setup();
    const flow = levelsFlow(
      { approvers: users('m1') },
      {
        groups: [
          { id: 'a', approvers: users('m1', 'x1'), mode: 'all' },
          { id: 'b', approvers: users('m1', 'x2'), mode: 'all' },
        ],
        ...auto,
      },
    );
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 'm1');
    expect(await t.slots(instance.id)).toEqual({
      a: ['m1:approved', 'x1:pending'],
      b: ['m1:approved', 'x2:pending'],
    });
    expect((await autoEntries(t, instance.id))[0]?.metadata).toMatchObject({
      groupIds: ['a', 'b'],
    });
  });

  it('does not carry approvals over to a new round', async () => {
    const t = setup();
    const flow = levelsFlow(
      { approvers: users('m1'), ...auto },
      { approvers: users('m1'), ...auto },
      { approvers: users('d1') },
    );
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 'm1');
    await t.engine.returnForRevision(instance.id, 'd1', 'fix');
    await t.engine.resubmit(instance.id, 'u7');
    expect(await t.activeNode(instance.id)).toBe('l1');
    expect(await t.slots(instance.id)).toEqual({ default: ['m1:pending'] });
    await t.engine.approve(instance.id, 'm1');
    // Level 2 is auto-approved again, from the round-2 decision.
    expect(await t.activeNode(instance.id)).toBe('l3');
  });

  it('asks again when a node is revisited through returnForRevision', async () => {
    const t = setup();
    const flow = levelsFlow({ approvers: users('m1'), ...auto }, { approvers: users('d1') });
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 'm1');
    await t.engine.returnForRevision(instance.id, 'd1', 'check again', { toNodeId: 'l1' });
    expect(await t.activeNode(instance.id)).toBe('l1');
    expect(await t.slots(instance.id)).toEqual({ default: ['m1:pending'] });
  });

  it('ignores approvals in a step that was returned', async () => {
    const t = setup();
    const flow = levelsFlow(
      { approvers: users('m1') },
      { approvers: users('d1', 'x1'), mode: 'all' },
      { approvers: users('d1'), ...auto },
    );
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 'm1');
    await t.engine.approve(instance.id, 'd1'); // in a step that x1 then returns
    await t.engine.returnForRevision(instance.id, 'x1', 'redo', { toNodeId: 'l1' });
    await t.engine.approve(instance.id, 'm1');
    await t.engine.approve(instance.id, 'd1');
    const done = await t.engine.approve(instance.id, 'x1');
    expect(done.status).toBe('approved');

    const state = await t.state(instance.id);
    const secondVisit = state.steps.find((step) => step.nodeId === 'l2' && step.iteration === 2);
    expect((await autoEntries(t, instance.id))[0]?.metadata?.fromStepId).toBe(secondVisit?.id);
  });

  it('applies to approval-chain levels', async () => {
    const t = setup();
    const flow = {
      id: 'chain-dup',
      name: 'Chain with duplicates',
      start: 'manager',
      nodes: {
        manager: {
          type: 'approval',
          approvers: users('m1'),
          mode: 'any',
          next: 'chain',
          onReject: 'rejected',
        },
        chain: {
          type: 'approval-chain',
          chain: 'supervisor',
          until: { type: 'role', value: 'director' },
          maxLevels: 5,
          duplicateApprover: 'auto-approve',
          next: 'approved',
          onReject: 'rejected',
        },
        ...END_NODES,
      },
    } satisfies FlowDefinition;
    const instance = await t.run(flow);
    await t.engine.approve(instance.id, 'm1');
    await t.engine.approve(instance.id, 's1');
    // Level 2 (m1) was approved automatically; the chain went on to the director.
    const state = await t.state(instance.id);
    expect(state.steps.map((step) => [step.nodeId, step.chainLevel, step.status])).toEqual([
      ['manager', 0, 'approved'],
      ['chain', 1, 'approved'],
      ['chain', 2, 'approved'],
      ['chain', 3, 'active'],
    ]);
    expect((await autoEntries(t, instance.id))[0]?.metadata).toMatchObject({ userId: 'm1' });
  });
});
