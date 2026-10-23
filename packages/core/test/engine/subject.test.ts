import { describe, expect, it } from 'vitest';
import { ActiveInstanceExistsError } from '../../src';
import { setup, twoLevelFlow } from './helpers';

describe('subject', () => {
  it('accepts free-form subject ids', async () => {
    const t = setup();
    await t.publish(twoLevelFlow);
    const instance = await t.engine.start('two-level', {
      subject: { type: 'purchase_request', id: 'PR/2026/10/007' },
      requester: { id: 'u7' },
    });
    expect(instance.subject).toEqual({ type: 'purchase_request', id: 'PR/2026/10/007' });
  });

  it('finds instances from the subject', async () => {
    const t = setup();
    const first = await t.run(twoLevelFlow, { subjectId: '42' });
    await t.run(twoLevelFlow, { subjectId: '43' });
    const found = await t.engine.findInstances({ subject: { type: 'doc', id: '42' } });
    expect(found).toEqual({ items: [first], total: 1 });
    expect((await t.engine.findInstances({ subject: { type: 'doc' } })).total).toBe(2);
    expect((await t.engine.findInstances({ subject: { type: 'invoice', id: '42' } })).total).toBe(
      0,
    );
  });

  it('allows only one active instance per subject', async () => {
    const t = setup();
    const first = await t.run(twoLevelFlow, { subjectId: '42' });
    const error = await t.run(twoLevelFlow, { subjectId: '42' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActiveInstanceExistsError);
    expect(error).toMatchObject({ subject: { type: 'doc', id: '42' } });

    // A returned instance is still active.
    await t.engine.returnForRevision(first.id, 's1', 'x');
    await expect(t.run(twoLevelFlow, { subjectId: '42' })).rejects.toThrow(
      ActiveInstanceExistsError,
    );

    // Once finished, the subject can be submitted again.
    await t.engine.cancel(first.id, 'u7');
    const second = await t.run(twoLevelFlow, { subjectId: '42' });
    expect(second.id).not.toBe(first.id);
    const history = await t.engine.findInstances({ subject: { type: 'doc', id: '42' } });
    expect(history.items.map((instance) => instance.status)).toEqual(['pending', 'cancelled']);
  });

  it('filters by status and flow, newest first, with pagination', async () => {
    const t = setup();
    const a = await t.run(twoLevelFlow, { subjectId: '1' });
    t.advance(1000);
    const b = await t.run(twoLevelFlow, { subjectId: '2' });
    t.advance(1000);
    const c = await t.run(twoLevelFlow, { subjectId: '3' });
    await t.engine.cancel(b.id, 'u7');

    const page = await t.engine.findInstances({ flowId: 'two-level', limit: 2 });
    expect(page.total).toBe(3);
    expect(page.items.map((instance) => instance.id)).toEqual([c.id, b.id]);
    const next = await t.engine.findInstances({ flowId: 'two-level', limit: 2, offset: 2 });
    expect(next.items.map((instance) => instance.id)).toEqual([a.id]);

    expect((await t.engine.findInstances({ status: 'cancelled' })).items.map((i) => i.id)).toEqual([
      b.id,
    ]);
    expect((await t.engine.findInstances({ status: ['pending', 'cancelled'] })).total).toBe(3);
    expect((await t.engine.findInstances({ flowId: 'other' })).total).toBe(0);
  });
});

describe('inbox', () => {
  it('lists steps waiting for the user, oldest first', async () => {
    const t = setup();
    const first = await t.run(twoLevelFlow, { subjectId: '1' });
    t.advance(1000);
    const second = await t.run(twoLevelFlow, { subjectId: '2' });

    const inbox = await t.engine.findPendingForUser('s1');
    expect(inbox.total).toBe(2);
    expect(inbox.items.map((item) => item.instance.id)).toEqual([first.id, second.id]);
    expect(inbox.items[0]).toMatchObject({
      nodeId: 'supervisor',
      groupIds: ['default'],
      dueAt: null,
    });
    expect(inbox.items[0]?.enteredAt).toEqual(new Date('2026-01-05T08:00:00.000Z'));

    expect(
      (await t.engine.findPendingForUser('s1', { limit: 1, offset: 1 })).items[0]?.instance.id,
    ).toBe(second.id);
    await t.engine.approve(first.id, 's1');
    expect((await t.engine.findPendingForUser('s1')).total).toBe(1);
    expect((await t.engine.findPendingForUser('d1')).items[0]?.nodeId).toBe('director');
  });
});
