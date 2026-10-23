// Paraf in plain Node.js: one purchase request from submission to approval, in memory.
//
//   pnpm --filter @paraf/core build && pnpm --filter basic-node start
//
// The flow: the requester's manager approves; above 10,000,000 the request then goes up the
// reporting line to a director; finally two people from finance must approve.
import assert from 'node:assert/strict';
import { createEngine, MemoryStore } from '@paraf/core';
import type { FlowDefinition } from '@paraf/core';

// --- Your organisation (in a real app: your users table, HR system, LDAP, ...) -------------

const people: Record<string, { name: string; manager?: string; roles: string[] }> = {
  u7: { name: 'Dimas (requester)', manager: 's1', roles: [] },
  s1: { name: 'Rina', manager: 'm1', roles: ['supervisor'] },
  m1: { name: 'Budi', manager: 'd1', roles: ['manager'] },
  d1: { name: 'Sari', roles: ['director'] },
  f1: { name: 'Fajar', roles: ['finance'] },
  f2: { name: 'Tika', roles: ['finance'] },
  f3: { name: 'Andi', roles: ['finance'] },
};
const name = (id: string) => people[id]?.name ?? id;

// --- The engine ------------------------------------------------------------------------------

const engine = createEngine({ store: new MemoryStore() });

// "Everyone with one of these roles".
engine.registerApproverType('role', ({ value }) => {
  const roles = Array.isArray(value) ? value : [value];
  return Object.keys(people).filter((id) => people[id]?.roles.some((role) => roles.includes(role)));
});

// "The requester's manager, `level` steps up".
engine.registerApproverType('supervisor', ({ level }, { requester }) => {
  let current: string | undefined = requester.id;
  for (let i = 0; i < Number(level ?? 1) && current; i++) current = people[current]?.manager;
  return current ? [current] : [];
});

// The reporting line, walked by approval-chain nodes.
engine.registerChain('reporting-line', (userId) => people[userId]?.manager ?? null);

engine.on('approval.required', ({ step, groups }) => {
  for (const group of groups) {
    console.log(`  → ${step.nodeId}: waiting for ${group.userIds.map(name).join(', ')}`);
  }
});
engine.on('instance.completed', ({ instance }) => {
  console.log(`  ✔ ${instance.subject.id} finished: ${instance.status}`);
});

// --- The flow ----------------------------------------------------------------------------------

const flow: FlowDefinition = {
  id: 'purchase-request',
  name: 'Purchase request',
  start: 'manager',
  variables: [{ key: 'amount', label: 'Amount', type: 'number', required: true }],
  nodes: {
    manager: {
      type: 'approval',
      label: 'Direct manager',
      approvers: [{ type: 'supervisor', level: 1 }],
      mode: 'any',
      next: 'check_amount',
      onReject: 'rejected',
    },
    check_amount: {
      type: 'condition',
      rules: [{ when: { '>': [{ var: 'amount' }, 10_000_000] }, next: 'up_to_director' }],
      else: 'finance',
    },
    up_to_director: {
      type: 'approval-chain',
      label: 'Up to a director',
      chain: 'reporting-line',
      until: { type: 'role', value: 'director' },
      maxLevels: 5,
      // Rina already approved as direct manager: don't ask her again.
      duplicateApprover: 'auto-approve',
      next: 'finance',
      onReject: 'rejected',
    },
    finance: {
      type: 'approval',
      label: 'Finance',
      approvers: [{ type: 'role', value: 'finance' }],
      mode: { minimum: 2 },
      next: 'approved',
      onReject: 'rejected',
    },
    approved: { type: 'end', result: 'approved' },
    rejected: { type: 'end', result: 'rejected' },
  },
};

await engine.publishFlow(flow, { createdBy: 'setup', notes: 'First version' });

// --- One request -------------------------------------------------------------------------------

console.log('Submitting PR-2026-001 for 15,000,000');
const instance = await engine.start('purchase-request', {
  subject: { type: 'purchase_request', id: 'PR-2026-001' },
  requester: { id: 'u7' },
  document: { amount: 15_000_000 },
});

await engine.approve(instance.id, 's1', 'Needed for the new office');
await engine.approve(instance.id, 'm1');
await engine.approve(instance.id, 'd1', 'Approved within budget');
await engine.approve(instance.id, 'f1');
const done = await engine.approve(instance.id, 'f3');

console.log('\nHistory:');
for (const entry of await engine.getHistory(instance.id)) {
  const who = entry.actorId ? name(entry.actorId) : 'system';
  console.log(`  ${entry.action.padEnd(20)} ${who}${entry.comment ? `: ${entry.comment}` : ''}`);
}

assert.equal(done.status, 'approved');
