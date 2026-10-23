import { progressOf } from '../src/model/progress';
import { createTestEngine, specFlow } from './fixtures';

async function run(amount: number) {
  const engine = createTestEngine();
  const flow = await engine.publishFlow(specFlow());
  const instance = await engine.start(flow.id, {
    subject: { type: 'pr', id: '1' },
    requester: { id: 'u7' },
    document: { amount },
  });
  const progress = async () => {
    const state = await engine.getInstance(instance.id);
    if (!state) throw new Error('missing instance');
    return progressOf(flow, state, await engine.getHistory(instance.id));
  };
  return { engine, id: instance.id, progress };
}

describe('progressOf', () => {
  it('follows an instance through a condition and an approval chain', async () => {
    const { engine, id, progress } = await run(15_000_000);
    let current = await progress();
    expect(current.nodes.supervisor?.status).toBe('active');
    expect(current.nodes.supervisor?.groups).toEqual([
      { id: 'default', label: 'default', approved: 0, required: 1 },
    ]);
    expect(current.activeStep?.nodeId).toBe('supervisor');

    await engine.approve(id, 's1');
    current = await progress();
    expect(current.nodes.supervisor).toMatchObject({ status: 'done', approvedBy: ['s1'] });
    expect(current.nodes.supervisor?.decidedAt).toBeInstanceOf(Date);
    expect(current.nodes.checkAmount?.status).toBe('done');
    expect([...current.takenEdges]).toEqual(['supervisor:next', 'checkAmount:rule-0']);
    expect(current.nodes.chain?.status).toBe('active');
    expect(current.nodes.chain?.levels.map((level) => [level.userId, level.status])).toEqual([
      ['s1', 'approved'],
      ['m1', 'active'],
    ]);

    await engine.approve(id, 'm1');
    await engine.approve(id, 'd1');
    current = await progress();
    expect(current.nodes.chain?.status).toBe('done');
    expect(current.nodes.review?.groups).toEqual([
      { id: 'mgr', label: 'Manager', approved: 0, required: 1 },
      { id: 'fin', label: 'Finance', approved: 0, required: 2 },
    ]);

    await engine.approve(id, 'm2');
    await engine.approve(id, 'f1');
    await engine.approve(id, 'a1');
    current = await progress();
    expect(current.nodes.review?.status).toBe('done');
    expect(current.nodes.end_approved?.status).toBe('done');
    expect(current.takenEdges.has('review:next')).toBe(true);
    expect(current.activeStep).toBeNull();
  });

  it('shows rejections and the else branch', async () => {
    const { engine, id, progress } = await run(5);
    await engine.approve(id, 's1');
    await engine.reject(id, 'm1', 'No budget');
    const current = await progress();
    expect(current.takenEdges.has('checkAmount:else')).toBe(true);
    expect(current.nodes.chain?.status).toBe('not-reached');
    expect(current.nodes.review?.status).toBe('rejected');
    expect(current.takenEdges.has('review:reject')).toBe(true);
    expect(current.nodes.end_rejected?.status).toBe('done');
  });

  it('only counts the current round after a resubmission', async () => {
    const { engine, id, progress } = await run(5);
    await engine.approve(id, 's1');
    await engine.returnForRevision(id, 'm1', 'Add a quote');
    expect((await progress()).nodes.review?.status).toBe('active');
    await engine.resubmit(id, 'u7', { amount: 5 });
    const current = await progress();
    expect(current.nodes.supervisor?.status).toBe('active');
    expect(current.nodes.checkAmount?.status).toBe('not-reached');
    expect(current.takenEdges.size).toBe(0);
  });

  it('marks skipped steps as done', async () => {
    const engine = createTestEngine();
    const flow = specFlow();
    flow.nodes.supervisor = {
      ...flow.nodes.supervisor,
      approvers: [{ type: 'supervisor', level: 9 }],
    } as never;
    const published = await engine.publishFlow(flow);
    const instance = await engine.start(published.id, {
      subject: { type: 'pr', id: '1' },
      requester: { id: 'u7' },
      document: { amount: 1 },
    });
    const state = await engine.getInstance(instance.id);
    const current = progressOf(published, state as never, await engine.getHistory(instance.id));
    expect(current.nodes.supervisor?.status).toBe('done');
    expect(current.nodes.supervisor?.approvedBy).toEqual([]);
    expect(current.takenEdges.has('supervisor:next')).toBe(true);
  });

  it('counts every approver of an "all" group', async () => {
    const engine = createTestEngine();
    const flow = specFlow();
    (flow.nodes.review as { groups: { mode: unknown }[] }).groups[0]!.mode = 'all';
    const published = await engine.publishFlow(flow);
    const instance = await engine.start(published.id, {
      subject: { type: 'pr', id: '1' },
      requester: { id: 'u7' },
      document: { amount: 1 },
    });
    await engine.approve(instance.id, 's1');
    const state = await engine.getInstance(instance.id);
    const current = progressOf(published, state as never, await engine.getHistory(instance.id));
    expect(current.nodes.review?.groups[0]).toEqual({
      id: 'mgr',
      label: 'Manager',
      approved: 0,
      required: 2,
    });
  });

  it('leaves a cancelled step as not reached', async () => {
    const { engine, id, progress } = await run(1);
    await engine.cancel(id, 'u7', 'Not needed');
    const current = await progress();
    expect(current.nodes.supervisor?.status).toBe('not-reached');
    expect(current.activeStep).toBeNull();
  });

  it('shows a chain level without a resolved user', async () => {
    const { engine, id } = await run(15_000_000);
    await engine.approve(id, 's1');
    const state = await engine.getInstance(id);
    if (!state) throw new Error('missing instance');
    const chainStep = state.steps.find(
      (step) => step.nodeId === 'chain' && step.status === 'active',
    );
    if (!chainStep) throw new Error('no chain step');
    Reflect.deleteProperty(chainStep.config, 'chain');
    const current = progressOf(
      await engine.publishFlow(specFlow()),
      state,
      await engine.getHistory(id),
    );
    const levels = current.nodes.chain?.levels ?? [];
    expect(levels[levels.length - 1]?.userId).toBeNull();
  });
});
