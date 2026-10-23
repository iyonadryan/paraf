import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { validateFlow } from '../../../packages/core/src/index';

/** The example flow from section 1 of the specification (without `version` and `layout`). */
const specExample = {
  id: 'purchase-request',
  name: 'Pengajuan Pembelian',
  start: 'supervisor',
  resubmitPolicy: 'restart',
  nodes: {
    supervisor: {
      type: 'approval',
      label: 'Atasan Langsung',
      approvers: [{ type: 'supervisor', level: 1 }],
      mode: 'any',
      excludeRequester: true,
      onEmptyApprovers: 'skip',
      timeout: { after: 'P3D', action: 'escalate', to: [{ type: 'supervisor', level: 2 }] },
      next: 'checkAmount',
      onReject: 'end_rejected',
    },
    checkAmount: {
      type: 'condition',
      rules: [{ when: { '>': [{ var: 'amount' }, 10000000] }, next: 'chain' }],
      else: 'review',
    },
    chain: {
      type: 'approval-chain',
      label: 'Naik sampai Direktur',
      chain: 'supervisor',
      from: 'requester',
      until: { type: 'role', value: 'director' },
      includeStopper: true,
      maxLevels: 5,
      duplicateApprover: 'auto-approve',
      next: 'review',
      onReject: 'end_rejected',
    },
    review: {
      type: 'approval',
      label: 'Manager & Finance (paralel)',
      groups: [
        {
          id: 'mgr',
          label: 'Manager',
          approvers: [{ type: 'role', value: 'manager' }],
          mode: 'any',
        },
        {
          id: 'fin',
          label: 'Finance',
          approvers: [{ type: 'role', value: ['finance', 'accounting'] }],
          mode: { minimum: 2 },
          rejectPolicy: 'impossible',
          onInsufficientApprovers: 'cap',
        },
      ],
      require: 'all',
      duplicateApprover: 'require',
      next: 'end_approved',
      onReject: 'end_rejected',
    },
    end_approved: { type: 'end', result: 'approved' },
    end_rejected: { type: 'end', result: 'rejected' },
  },
};

const panel = (page: Page) => page.locator('aside.paraf-panel');

async function rename(page: Page, id: string) {
  const input = panel(page).getByRole('textbox', { name: 'Node ID' });
  await input.fill(id);
  await input.press('Enter');
  await expect(page.getByTestId(`node-${id}`)).toBeVisible();
}

async function setLabel(page: Page, label: string) {
  await panel(page).getByLabel('Label', { exact: true }).fill(label);
}

async function select(page: Page, id: string) {
  await page.getByTestId(`node-${id}`).click();
  await expect(panel(page).getByRole('textbox', { name: 'Node ID' })).toHaveValue(id);
}

/** Adds the approver type `type` in `scope` (a list of sources or the "stop at" field). */
async function addSource(scope: Locator, button: RegExp | string, type: RegExp) {
  await scope.getByRole('button', { name: button }).click();
  await scope.page().getByRole('menuitem', { name: type }).click();
}

async function quickAdd(page: Page, source: string | null, type: RegExp) {
  const anchor =
    source === null ? page.getByTestId('node-start') : page.getByTestId(`node-${source}`);
  await anchor.getByRole('button', { name: 'Add next node' }).click();
  await page.getByRole('menuitem', { name: type }).click();
}

async function exportFlow(page: Page): Promise<{ text: string; flow: Record<string, unknown> }> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export JSON' }).click(),
  ]);
  const path = await download.path();
  const text = await readFile(path, 'utf8');
  return { text, flow: JSON.parse(text) as Record<string, unknown> };
}

test('builds the specification example from scratch, exports it, and imports it back', async ({
  page,
}) => {
  await page.goto('/');

  // Flow settings.
  await panel(page).getByLabel('Flow name').fill('Pengajuan Pembelian');
  await panel(page)
    .getByLabel('When a returned document is resubmitted')
    .selectOption({ label: 'Restart from the beginning' });

  // supervisor: added with + under Start.
  await quickAdd(page, null, /^Approval One level/);
  await rename(page, 'supervisor');
  await setLabel(page, 'Atasan Langsung');
  const approvers = panel(page).getByRole('group', { name: 'Approvers', exact: true });
  await addSource(approvers, '+ Add approver source', /^Manager/);
  await approvers.getByLabel('Level').fill('1');
  await panel(page)
    .getByRole('checkbox', { name: /Exclude the requester/ })
    .check();
  await panel(page).getByLabel('If nobody is found').selectOption({ label: 'Skip this step' });
  await panel(page)
    .getByRole('checkbox', { name: /Escalate after a timeout/ })
    .check();
  await expect(panel(page).getByLabel('After', { exact: true })).toHaveValue('P3D');
  const escalateTo = panel(page).getByRole('group', { name: 'Escalate to' });
  await addSource(escalateTo, '+ Add approver source', /^Manager/);
  await escalateTo.getByLabel('Level').fill('2');

  // checkAmount: + under supervisor.
  await quickAdd(page, 'supervisor', /^Condition Branch/);
  await rename(page, 'checkAmount');
  await setLabel(page, '');
  await panel(page).getByRole('button', { name: '+ Add rule' }).click();
  const rule = panel(page).getByRole('group', { name: 'Rule 1' });
  await rule.getByRole('button', { name: '+ Add condition (AND / OR)' }).click();
  await rule.getByRole('button', { name: 'Choose a variable' }).click();
  const custom = page.getByLabel('Other field');
  await custom.fill('amount');
  await custom.press('Enter');
  await rule.getByLabel('Operator').selectOption('>');
  await rule.getByLabel('Type').selectOption('number');
  await rule.getByLabel('Value').fill('10000000');

  // review: + under checkAmount (its "else").
  await quickAdd(page, 'checkAmount', /^Approval One level/);
  await rename(page, 'review');
  await setLabel(page, 'Manager & Finance (paralel)');
  await panel(page).getByRole('button', { name: 'Split into parallel groups' }).click();
  const first = panel(page).getByRole('group', { name: 'group_1' });
  await first.getByLabel('Group ID').fill('mgr');
  await panel(page).getByRole('group', { name: 'mgr' }).getByLabel('Group name').fill('Manager');
  const manager = panel(page).getByRole('group', { name: 'Manager', exact: true });
  await addSource(manager, '+ Add approver source', /^Role/);
  await manager.getByRole('checkbox', { name: 'manager' }).check();
  await panel(page).getByRole('button', { name: '+ Add group' }).click();
  const second = panel(page).getByRole('group', { name: 'group_2' });
  await second.getByLabel('Group ID').fill('fin');
  await panel(page).getByRole('group', { name: 'fin' }).getByLabel('Group name').fill('Finance');
  const finance = panel(page).getByRole('group', { name: 'Finance', exact: true });
  await addSource(finance, '+ Add approver source', /^Role/);
  await finance.getByRole('checkbox', { name: 'finance' }).check();
  await finance.getByRole('checkbox', { name: 'accounting' }).check();
  await finance.getByRole('button', { name: 'At least n' }).click();
  await expect(finance.getByLabel('n', { exact: true })).toHaveValue('2');
  await finance
    .getByLabel('Rejected when')
    .selectOption({ label: 'The minimum can no longer be reached' });
  await finance
    .getByLabel('If there are fewer than n approvers')
    .selectOption({ label: 'Lower the minimum (cap)' });
  await panel(page)
    .getByLabel('Node completes when')
    .selectOption({ label: 'All groups are satisfied' });
  await panel(page)
    .getByLabel('Approvers who already approved at an earlier level')
    .selectOption({ label: 'Must approve again' });

  // chain and the end nodes: from the palette.
  const palette = page.getByRole('navigation', { name: 'Nodes' });
  await palette.getByRole('button', { name: /^Approval chain/ }).click();
  await rename(page, 'chain');
  await setLabel(page, 'Naik sampai Direktur');
  await expect(panel(page).getByLabel('Chain', { exact: true })).toHaveValue('supervisor');
  await panel(page).getByLabel('Start from').selectOption({ label: 'The requester' });
  await addSource(panel(page), '+ Add a stop condition', /^Role/);
  await panel(page).getByRole('checkbox', { name: 'director' }).check();
  const stopper = panel(page).getByRole('checkbox', { name: /That person approves too/ });
  await stopper.uncheck();
  await stopper.check(); // explicit includeStopper: true, as in the example
  await expect(panel(page).getByLabel('Maximum levels')).toHaveValue('5');
  await panel(page)
    .getByLabel('Approvers who already approved at an earlier level')
    .selectOption({ label: 'Auto-approve' });
  await panel(page).getByLabel('Then go to').selectOption('review');
  await panel(page).getByLabel('If rejected, go to').selectOption({ index: 0 });

  await palette.getByRole('button', { name: /^End/ }).click();
  await rename(page, 'end_approved');
  await palette.getByRole('button', { name: /^End/ }).click();
  await rename(page, 'end_rejected');
  await panel(page).getByRole('button', { name: 'Rejected' }).click();

  // Remaining connections, in the panel...
  await select(page, 'chain');
  await panel(page).getByLabel('If rejected, go to').selectOption('end_rejected');
  await select(page, 'checkAmount');
  await panel(page)
    .getByRole('group', { name: 'Rule 1' })
    .getByLabel('Go to')
    .selectOption('chain');
  await select(page, 'review');
  await panel(page).getByLabel('Then go to').selectOption('end_approved');
  await panel(page).getByLabel('If rejected, go to').selectOption('end_rejected');

  // ...and one drawn on the canvas: supervisor's reject handle to end_rejected.
  await page.getByRole('button', { name: 'Tidy up' }).click();
  await page.waitForTimeout(400);
  const handle = page.getByTestId('node-supervisor').getByTestId('handle-reject');
  const target = page.getByTestId('node-end_rejected');
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('canvas elements not found');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 8, { steps: 12 });
  await page.mouse.up();

  await expect(page.locator('.paraf-status__valid')).toHaveText(/Flow is valid/);
  await expect(page.locator('.react-flow__edge')).toHaveCount(9);

  // Export: exactly the example, valid for the engine.
  const exported = await exportFlow(page);
  const { layout, ...flow } = exported.flow;
  expect(flow).toEqual(specExample);
  expect(Object.keys(layout as object).sort()).toEqual(Object.keys(specExample.nodes).sort());
  expect(
    validateFlow(exported.flow, { approverTypes: ['role', 'supervisor'], chains: ['supervisor'] }),
  ).toEqual([]);

  // Import into a fresh editor: nothing is lost.
  await page.getByRole('button', { name: 'New flow' }).click();
  await expect(page.getByText('This flow is empty')).toBeVisible();
  await page.getByTestId('paraf-import').setInputFiles({
    name: 'purchase-request.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exported.text),
  });
  await expect(page.getByTestId('node-review')).toBeVisible();
  const again = await exportFlow(page);
  expect(again.text).toBe(exported.text);
});
