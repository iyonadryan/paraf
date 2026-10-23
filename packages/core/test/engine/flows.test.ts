import { describe, expect, it, vi } from 'vitest';
import {
  FlowNotFoundError,
  FlowValidationError,
  FlowVersionExistsError,
  MemoryStore,
} from '../../src';
import { setup, singleStepFlow, twoLevelFlow } from './helpers';

describe('flow versioning', () => {
  it('assigns increasing versions and never overwrites', async () => {
    const t = setup();
    const v1 = await t.engine.publishFlow(twoLevelFlow);
    const v2 = await t.engine.publishFlow({ ...twoLevelFlow, name: 'Renamed', version: 99 });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect((await t.engine.getActiveFlow('two-level'))?.name).toBe('Renamed');
    expect((await t.engine.getFlow('two-level', 1))?.name).toBe('Two levels');
    expect(await t.engine.getFlow('two-level', 3)).toBeNull();
    expect(await t.engine.listFlows()).toEqual([
      { id: 'two-level', name: 'Renamed', activeVersion: 2, latestVersion: 2 },
    ]);
  });

  it('keeps running instances on the version they started with', async () => {
    const t = setup();
    const v1 = singleStepFlow(
      { approvers: [{ type: 'user', value: 'old' }], mode: 'any', next: 'approved' },
      'f',
    );
    const v2 = singleStepFlow({ approvers: [{ type: 'user', value: 'new' }], mode: 'any' }, 'f');
    await t.engine.publishFlow(v1);
    const before = await t.run(v1, { subjectId: '1' });
    await t.engine.publishFlow(v2);
    const after = await t.run(v2, { subjectId: '2' });

    expect([before.flowVersion, after.flowVersion]).toEqual([1, 2]);
    expect(await t.slots(before.id)).toEqual({ default: ['old:pending'] });
    expect(await t.slots(after.id)).toEqual({ default: ['new:pending'] });
    expect((await t.engine.approve(before.id, 'old')).status).toBe('approved');
  });

  it('rolls back with activateFlowVersion', async () => {
    const t = setup();
    await t.engine.publishFlow(twoLevelFlow);
    await t.engine.publishFlow({ ...twoLevelFlow, name: 'v2' });
    await t.engine.activateFlowVersion('two-level', 1);
    const instance = await t.engine.start('two-level', {
      subject: { type: 'doc', id: '1' },
      requester: { id: 'u7' },
    });
    expect(instance.flowVersion).toBe(1);
    await expect(t.engine.activateFlowVersion('two-level', 7)).rejects.toThrow(FlowNotFoundError);
  });

  it('validates on publish against the registered approver types and operators', async () => {
    const t = setup();
    const flow = singleStepFlow({ approvers: [{ type: 'department', value: 'IT' }], mode: 'any' });
    const error = await t.engine.publishFlow(flow).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FlowValidationError);
    expect((error as FlowValidationError).issues.map((issue) => issue.code)).toEqual([
      'UNKNOWN_APPROVER_TYPE',
    ]);
    expect(await t.engine.listFlows()).toEqual([]);

    const conditional = {
      id: 'c',
      name: 'C',
      start: 'check',
      nodes: {
        check: { type: 'condition', rules: [{ when: { isWeekend: [] }, next: 'ok' }], else: 'ok' },
        ok: { type: 'end', result: 'approved' },
      },
    } as const;
    await expect(t.engine.publishFlow(conditional as never)).rejects.toThrow(FlowValidationError);
    t.engine.registerOperator('isWeekend', () => false);
    expect((await t.engine.publishFlow(conditional as never)).version).toBe(1);
  });

  it('retries when another process published the same version first', async () => {
    const store = new MemoryStore();
    const t = setup({ store });
    const save = vi.spyOn(store, 'saveFlowVersion');
    save.mockRejectedValueOnce(new FlowVersionExistsError('two-level', 1));
    const published = await t.engine.publishFlow(twoLevelFlow);
    expect(published.version).toBe(1);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('passes createdBy to the store and rethrows other store errors', async () => {
    const store = new MemoryStore();
    const t = setup({ store, maxRetries: 0 });
    const save = vi.spyOn(store, 'saveFlowVersion');
    await t.engine.publishFlow(twoLevelFlow, { createdBy: 'admin' });
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ version: 1 }), {
      createdBy: 'admin',
    });

    save.mockRejectedValueOnce(new FlowVersionExistsError('two-level', 2));
    await expect(t.engine.publishFlow(twoLevelFlow)).rejects.toThrow(FlowVersionExistsError);
  });

  it('lists versions with who published them, when, and their notes', async () => {
    const t = setup();
    await t.engine.publishFlow(twoLevelFlow);
    await t.engine.publishFlow(
      { ...twoLevelFlow, name: 'Renamed' },
      { createdBy: 'dev-1', notes: 'Rename the flow' },
    );
    expect(await t.engine.listFlowVersions('two-level')).toEqual([
      {
        version: 2,
        name: 'Renamed',
        createdBy: 'dev-1',
        notes: 'Rename the flow',
        createdAt: expect.any(Date),
      },
      { version: 1, name: 'Two levels', createdBy: null, notes: null, createdAt: expect.any(Date) },
    ]);
    expect(await t.engine.listFlowVersions('missing')).toEqual([]);
  });

  it('loads flow versions from the store after a restart', async () => {
    const t = setup();
    const instance = await t.run(twoLevelFlow);
    const other = setup({ store: t.store });
    expect((await other.engine.approve(instance.id, 's1')).status).toBe('in_progress');
  });
});
