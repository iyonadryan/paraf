import {
  ActiveInstanceExistsError,
  createEngine,
  FlowNotFoundError,
  FlowVersionExistsError,
  uuidv7,
} from '@paraf/core';
import type { FlowDefinition, InstanceState, ParafStore } from '@paraf/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditEntry, FLOW_ID, flowVersion, instanceState, time } from './fixtures';

export { auditEntry, flowVersion, instanceState, time } from './fixtures';

/** How the contract suite gets a store. */
export interface StoreHarness {
  /** Prepares the backend once (e.g. connect and migrate). */
  setup?(): Promise<void>;
  /** Returns a store over empty storage. Called before every test. */
  create(): Promise<ParafStore> | ParafStore;
  /** Releases resources after the suite. */
  teardown?(): Promise<void>;
}

/** A copy of `state` with the instance fields changed and the revision incremented. */
function next(state: InstanceState, change: (state: InstanceState) => void): InstanceState {
  const copy = structuredClone(state);
  copy.instance.revision += 1;
  change(copy);
  return copy;
}

/**
 * The behaviour every `ParafStore` must have. Call it from a test file of an adapter:
 * `describeStoreContract('PostgresStore', harness)`.
 */
export function describeStoreContract(name: string, harness: StoreHarness): void {
  describe(`${name} (store contract)`, () => {
    let store: ParafStore;

    beforeAll(async () => {
      await harness.setup?.();
    });
    beforeEach(async () => {
      store = await harness.create();
      await store.saveFlowVersion(flowVersion(1));
      await store.setActiveVersion(FLOW_ID, 1);
    });
    afterAll(async () => {
      await harness.teardown?.();
    });

    describe('flows', () => {
      it('round-trips a flow version', async () => {
        expect(await store.getFlowVersion(FLOW_ID, 1)).toEqual(flowVersion(1));
        expect(await store.getActiveFlow(FLOW_ID)).toEqual(flowVersion(1));
      });

      it('never overwrites a version', async () => {
        await expect(store.saveFlowVersion(flowVersion(1, { name: 'Other' }))).rejects.toThrow(
          FlowVersionExistsError,
        );
        expect((await store.getFlowVersion(FLOW_ID, 1))?.name).toBe(flowVersion(1).name);
      });

      it('returns null for missing flows and versions', async () => {
        expect(await store.getFlowVersion(FLOW_ID, 9)).toBeNull();
        expect(await store.getFlowVersion('nope', 1)).toBeNull();
        expect(await store.getActiveFlow('nope')).toBeNull();
      });

      it('activates existing versions only', async () => {
        await store.saveFlowVersion(flowVersion(2, { name: 'v2' }));
        expect((await store.getActiveFlow(FLOW_ID))?.version).toBe(1);
        await store.setActiveVersion(FLOW_ID, 2);
        expect((await store.getActiveFlow(FLOW_ID))?.name).toBe('v2');
        await store.setActiveVersion(FLOW_ID, 1);
        expect((await store.getActiveFlow(FLOW_ID))?.version).toBe(1);
        await expect(store.setActiveVersion(FLOW_ID, 7)).rejects.toThrow(FlowNotFoundError);
        await expect(store.setActiveVersion('nope', 1)).rejects.toThrow(FlowNotFoundError);
      });

      it('lists flows by id with latest and active versions', async () => {
        await store.saveFlowVersion(flowVersion(3, { name: 'v3' }));
        await store.saveFlowVersion(flowVersion(2, { name: 'v2' }));
        await store.saveFlowVersion({ ...flowVersion(1), id: 'another-flow', name: 'Another' });
        expect(await store.listFlows()).toEqual([
          { id: 'another-flow', name: 'Another', activeVersion: null, latestVersion: 1 },
          { id: FLOW_ID, name: 'v3', activeVersion: 1, latestVersion: 3 },
        ]);
      });
    });

    describe('instances', () => {
      it('round-trips an instance with its steps and approver slots', async () => {
        const state = instanceState();
        await store.createInstance(state, []);
        expect(await store.getInstance(state.instance.id)).toEqual(state);
        expect(await store.getInstance(uuidv7())).toBeNull();
      });

      it('round-trips an instance without steps', async () => {
        // E.g. a flow whose condition led straight to an end node.
        const state = instanceState({ status: 'approved' });
        state.instance.currentStepId = null;
        state.steps = [];
        state.approvers = [];
        await store.createInstance(state, []);
        expect(await store.getInstance(state.instance.id)).toEqual(state);
      });

      it('removes every approver slot when the new state has none', async () => {
        const state = instanceState();
        await store.createInstance(state, []);
        const emptied = next(state, (s) => {
          s.approvers = [];
        });
        expect(await store.updateInstance(emptied, 0, [])).toBe(true);
        expect(await store.getInstance(state.instance.id)).toEqual(emptied);
      });

      it('treats malformed ids as unknown', async () => {
        expect(await store.getInstance('not-a-uuid')).toBeNull();
        expect(await store.getAudit('not-a-uuid')).toEqual([]);
      });

      it('keeps the order of steps and approver slots', async () => {
        const state = instanceState({
          pending: [
            ['z9', 'default'],
            ['a1', 'default'],
          ],
        });
        await store.createInstance(state, []);
        const loaded = await store.getInstance(state.instance.id);
        expect(loaded?.approvers.map((slot) => slot.userId)).toEqual(
          state.approvers.map((slot) => slot.userId),
        );
      });

      it('stores the audit entries of the creating action', async () => {
        const state = instanceState();
        const entries = [
          auditEntry(state.instance.id),
          auditEntry(state.instance.id, {
            action: 'step_entered',
            stepId: state.steps[1]!.id,
            nodeId: 'supervisor',
            metadata: { groups: [{ groupId: 'default', approvers: ['s1'] }], level: 1 },
          }),
        ];
        await store.createInstance(state, entries);
        expect(await store.getAudit(state.instance.id)).toEqual(entries);
      });

      it('updates instance, steps, and slots, and appends audit, in one go', async () => {
        const state = instanceState();
        await store.createInstance(state, [auditEntry(state.instance.id)]);
        const stepId = uuidv7();
        const updated = next(state, (s) => {
          s.instance.status = 'approved';
          s.instance.currentStepId = stepId;
          s.instance.updatedAt = time(5_000);
          s.instance.completedAt = time(5_000);
          s.instance.document = { amount: 1 };
          s.steps[1]!.status = 'approved';
          s.steps[1]!.dueAt = null;
          s.steps[1]!.completedAt = time(5_000);
          s.steps[1]!.config.groups[0]!.status = 'approved';
          s.steps.push({
            ...structuredClone(s.steps[1]!),
            id: stepId,
            iteration: 3,
            status: 'active',
          });
          s.approvers.splice(1, 1); // removed by a re-resolve
          s.approvers[0]!.comment = 'changed';
          s.approvers.push({
            ...structuredClone(s.approvers[0]!),
            id: uuidv7(),
            stepId,
            userId: 'new',
          });
        });
        const audit = auditEntry(state.instance.id, {
          action: 'approved',
          actorId: 's1',
          comment: 'ok',
        });

        expect(await store.updateInstance(updated, 0, [audit])).toBe(true);
        expect(await store.getInstance(state.instance.id)).toEqual(updated);
        expect((await store.getAudit(state.instance.id)).map((e) => e.action)).toEqual([
          'started',
          'approved',
        ]);
      });

      it('rejects an update at a stale revision and changes nothing', async () => {
        const state = instanceState();
        await store.createInstance(state, []);
        const first = next(state, (s) => {
          s.instance.status = 'approved';
        });
        expect(await store.updateInstance(first, 0, [auditEntry(state.instance.id)])).toBe(true);

        const stale = next(state, (s) => {
          s.instance.status = 'rejected';
          s.approvers = [];
        });
        const audit = auditEntry(state.instance.id, { action: 'rejected' });
        expect(await store.updateInstance(stale, 0, [audit])).toBe(false);
        expect(await store.getInstance(state.instance.id)).toEqual(first);
        expect(await store.getAudit(state.instance.id)).toHaveLength(1);
        expect(await store.updateInstance(instanceState(), 0, [])).toBe(false);
      });

      it('lets exactly one of two concurrent updates win', async () => {
        const state = instanceState();
        await store.createInstance(state, []);
        const results = await Promise.all(
          ['approved', 'rejected'].map((status) =>
            store.updateInstance(
              next(state, (s) => {
                s.instance.status = status as 'approved';
              }),
              0,
              [],
            ),
          ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });

    describe('one active instance per subject', () => {
      const subject = { type: 'purchase_request', id: '42' };

      it('rejects a second active instance and stores nothing of it', async () => {
        await store.createInstance(instanceState({ subject }), []);
        const second = instanceState({ subject, status: 'returned' });
        const error = await store
          .createInstance(second, [auditEntry(second.instance.id)])
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ActiveInstanceExistsError);
        expect((error as ActiveInstanceExistsError).subject).toEqual(subject);
        expect(await store.getInstance(second.instance.id)).toBeNull();
      });

      it('allows a new instance once the previous one finished', async () => {
        await store.createInstance(instanceState({ subject, status: 'approved' }), []);
        await store.createInstance(instanceState({ subject, status: 'cancelled' }), []);
        await store.createInstance(instanceState({ subject, status: 'pending' }), []);
        await store.createInstance(instanceState({ subject: { ...subject, type: 'invoice' } }), []);
        expect((await store.findInstances({ subject })).total).toBe(3);
      });

      it('enforces the rule under concurrency', async () => {
        const results = await Promise.allSettled(
          [1, 2, 3].map(() => store.createInstance(instanceState({ subject }), [])),
        );
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        for (const result of results) {
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(ActiveInstanceExistsError);
          }
        }
      });

      it('rolls back an update that would create a second active instance', async () => {
        await store.createInstance(instanceState({ subject }), []);
        const finished = instanceState({ subject, status: 'approved' });
        await store.createInstance(finished, []);
        const reopened = next(finished, (s) => {
          s.instance.status = 'in_progress';
          s.steps[0]!.status = 'rejected';
        });
        await expect(
          store.updateInstance(reopened, 0, [auditEntry(finished.instance.id)]),
        ).rejects.toThrow(ActiveInstanceExistsError);
        expect(await store.getInstance(finished.instance.id)).toEqual(finished);
        expect(await store.getAudit(finished.instance.id)).toEqual([]);
      });
    });

    describe('queries', () => {
      it('finds instances by subject, status, and flow, newest first, paginated', async () => {
        const a = instanceState({ subject: { type: 'doc', id: '1' }, createdAt: time(1) });
        const b = instanceState({
          subject: { type: 'doc', id: '2' },
          status: 'cancelled',
          createdAt: time(2),
        });
        const c = instanceState({ subject: { type: 'memo', id: '1' }, createdAt: time(3) });
        for (const state of [a, b, c]) await store.createInstance(state, []);

        const ids = async (query: Parameters<ParafStore['findInstances']>[0]) =>
          (await store.findInstances(query)).items.map((instance) => instance.id);

        expect(await store.findInstances({ subject: { type: 'doc', id: '1' } })).toEqual({
          items: [a.instance],
          total: 1,
        });
        expect(await ids({ subject: { type: 'doc' } })).toEqual([b.instance.id, a.instance.id]);
        expect(await ids({ status: 'cancelled' })).toEqual([b.instance.id]);
        expect(await ids({ status: ['in_progress', 'cancelled'] })).toHaveLength(3);
        expect(await ids({ flowId: 'other' })).toEqual([]);
        expect(await ids({ flowId: FLOW_ID, limit: 2 })).toEqual([c.instance.id, b.instance.id]);
        const page = await store.findInstances({ limit: 2, offset: 2 });
        expect(page).toEqual({ items: [a.instance], total: 3 });
      });

      it('lists pending steps per user with their groups, oldest first', async () => {
        const older = instanceState({
          subject: { type: 'doc', id: '1' },
          pending: [
            ['u1', 'default'],
            ['u1', 'legal'],
            ['u2', 'default'],
          ],
        });
        const newer = instanceState({
          subject: { type: 'doc', id: '2' },
          pending: [['u1', 'default']],
        });
        newer.steps[1]!.enteredAt = time(10_000);
        const decided = instanceState({
          subject: { type: 'doc', id: '3' },
          pending: [['u1', 'default']],
        });
        decided.approvers.slice(-1)[0]!.status = 'approved';
        const inactive = instanceState({
          subject: { type: 'doc', id: '4' },
          pending: [['u1', 'default']],
        });
        inactive.steps[1]!.status = 'cancelled';
        for (const state of [newer, older, decided, inactive])
          await store.createInstance(state, []);

        const inbox = await store.findPendingForUser('u1');
        expect(inbox.total).toBe(2);
        expect(inbox.items[0]).toEqual({
          instance: older.instance,
          stepId: older.steps[1]!.id,
          nodeId: 'supervisor',
          groupIds: ['default', 'legal'],
          enteredAt: older.steps[1]!.enteredAt,
          dueAt: older.steps[1]!.dueAt,
        });
        expect(inbox.items[1]?.instance.id).toBe(newer.instance.id);
        const second = await store.findPendingForUser('u1', { limit: 1, offset: 1 });
        expect(second.items.map((item) => item.instance.id)).toEqual([newer.instance.id]);
        expect(second.total).toBe(2);
        expect((await store.findPendingForUser('nobody')).items).toEqual([]);
      });

      it('finds instances whose active step is due', async () => {
        const due = instanceState({ subject: { type: 'doc', id: '1' }, dueAt: time(1_000) });
        const later = instanceState({ subject: { type: 'doc', id: '2' }, dueAt: time(5_000) });
        const none = instanceState({ subject: { type: 'doc', id: '3' }, dueAt: null });
        for (const state of [due, later, none]) await store.createInstance(state, []);

        expect(await store.findTimedOut(time(999))).toEqual([]);
        expect(await store.findTimedOut(time(1_000))).toEqual([due]);
        const both = await store.findTimedOut(time(10_000));
        expect(both.map((state) => state.instance.id).sort()).toEqual(
          [due.instance.id, later.instance.id].sort(),
        );
      });
    });

    describe('audit', () => {
      it('appends entries in order and round-trips them', async () => {
        const state = instanceState();
        await store.createInstance(state, [auditEntry(state.instance.id)]);
        const entries = [
          auditEntry(state.instance.id, {
            action: 'escalated',
            stepId: state.steps[1]!.id,
            nodeId: 'supervisor',
            timestamp: time(0),
            metadata: { approvers: [], dueAt: '2026-01-08T08:00:00.000Z' },
          }),
          auditEntry(state.instance.id, { action: 'cancelled', actorId: 'u7', comment: 'Batal ✓' }),
        ];
        await store.appendAudit(entries.slice(0, 1));
        await store.appendAudit(entries.slice(1));
        await store.appendAudit([]);
        expect((await store.getAudit(state.instance.id)).slice(1)).toEqual(entries);
        expect(await store.getAudit(uuidv7())).toEqual([]);
      });
    });

    describe('with the engine', () => {
      const flow = {
        id: 'engine-flow',
        name: 'Engine flow',
        start: 'chain',
        nodes: {
          chain: {
            type: 'approval-chain',
            chain: 'supervisor',
            until: { type: 'user', value: 'm1' },
            maxLevels: 3,
            timeout: { after: 'PT1H', action: 'escalate', to: [{ type: 'user', value: 'boss' }] },
            next: 'all',
            onReject: 'rejected',
          },
          all: {
            type: 'approval',
            approvers: [{ type: 'user', value: ['d1', 'd2'] }],
            mode: 'all',
            next: 'approved',
            onReject: 'rejected',
          },
          approved: { type: 'end', result: 'approved' },
          rejected: { type: 'end', result: 'rejected' },
        },
      } satisfies FlowDefinition;

      it('runs a flow end to end, including concurrent approvals and timeouts', async () => {
        const engine = createEngine({ store, now: () => time(0) });
        const supervisors: Record<string, string> = { u7: 's1', s1: 'm1' };
        engine.registerChain('supervisor', (user) => supervisors[user]);
        await engine.publishFlow(flow);
        await engine.publishFlow({ ...flow, name: 'Engine flow v2' });
        expect((await engine.listFlows()).find((f) => f.id === flow.id)?.latestVersion).toBe(2);

        const instance = await engine.start(flow.id, {
          subject: { type: 'doc', id: 'e2e' },
          requester: { id: 'u7' },
        });
        expect(await engine.processTimeouts(time(3_600_000))).toMatchObject({
          escalated: [{ instanceId: instance.id }],
        });
        await engine.approve(instance.id, 's1');
        await engine.approve(instance.id, 'm1');
        await Promise.all([engine.approve(instance.id, 'd1'), engine.approve(instance.id, 'd2')]);

        const state = await engine.getInstance(instance.id);
        expect(state?.instance).toMatchObject({ status: 'approved', flowVersion: 2 });
        expect(state?.approvers.filter((slot) => slot.status === 'approved')).toHaveLength(4);
        const actions = (await engine.getHistory(instance.id)).map((entry) => entry.action);
        expect(actions.filter((action) => action === 'approved')).toHaveLength(4);
        expect(actions).toContain('escalated');
        expect(actions.slice(-1)).toEqual(['completed']);
      });
    });
  });
}
