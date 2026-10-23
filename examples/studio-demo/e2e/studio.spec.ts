import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { E2E_TOKEN } from '../playwright.config';

async function unlock(page: Page) {
  await page.goto(`/?token=${E2E_TOKEN}`);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Flows' })).toBeVisible();
}

test('stays locked without the token', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Paraf Studio is locked' })).toBeVisible();
  const api = await page.request.get('/api/flows');
  expect(api.status()).toBe(401);
  await page.goto('/?token=wrong');
  await expect(page.getByRole('heading', { name: 'Paraf Studio is locked' })).toBeVisible();
});

test('edits, publishes, and rolls back a flow', async ({ page }) => {
  await unlock(page);
  await expect(page.getByText('PRODUCTION', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Purchase request' }).click();
  await expect(page.getByTestId('node-manager')).toBeVisible();

  // Edit and publish v2 with release notes; the dialog says where it goes.
  await page.getByTestId('node-manager').click();
  await page
    .locator('aside.paraf-panel')
    .getByLabel('Label', { exact: true })
    .fill('Direct manager');
  await page.getByRole('button', { name: 'Publish v2' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish version 2' });
  await expect(dialog.getByText(/^Publishing to PRODUCTION\./)).toBeVisible();
  await expect(dialog.getByText('manager: label')).toBeVisible();
  await dialog.getByRole('textbox').fill('Rename the first step');
  await dialog.getByRole('button', { name: 'Publish v2' }).click();
  await expect(page.getByRole('status')).toHaveText(/Published purchase-request v2\./);
  await expect(page.getByText('active: v2')).toBeVisible();

  // The history lists both versions; roll back to v1.
  await page.getByRole('button', { name: 'Versions (2)' }).click();
  const versions = page.getByRole('complementary', { name: 'Versions' });
  await expect(versions.getByText('Rename the first step')).toBeVisible();
  await expect(versions.getByText('First version')).toBeVisible();
  await versions.getByRole('button', { name: 'Make active' }).click();
  const confirm = page.getByRole('dialog', { name: 'Make v1 active' });
  await expect(confirm).toContainText('New submissions in PRODUCTION will use v1 instead of v2.');
  await confirm.getByRole('button', { name: 'Make v1 active' }).click();
  await expect(page.getByRole('status')).toHaveText(/^v1 is now active./);
  await expect(page.getByText('active: v1')).toBeVisible();
  await expect(page.getByTestId('node-manager')).toContainText('Manager');
  // The next version is numbered after the latest one.
  await expect(page.getByRole('button', { name: 'Publish v3' })).toBeVisible();

  // Open v2 again in the editor.
  await versions.getByRole('button', { name: 'Open in editor' }).first().click();
  await expect(page.getByTestId('node-manager')).toContainText('Direct manager');
  await page.goto('/');
  await expect(page.getByRole('row', { name: /Purchase request/ })).toContainText('v1');
});

test('creates a new flow from a template', async ({ page }) => {
  await unlock(page);
  await page.getByRole('link', { name: 'New flow' }).click();
  await page.getByRole('button', { name: /^Single level/ }).click();
  const panel = page.locator('aside.paraf-panel');
  // Templates leave the approvers to fill in.
  await page.getByTestId('node-approval').click();
  await panel
    .getByRole('group', { name: 'Approvers', exact: true })
    .getByLabel('Users', { exact: true })
    .fill('m1');
  await page.getByRole('button', { name: 'Fit view' }).click();
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await panel.getByLabel('Flow name').fill('Leave request');
  await panel.getByLabel('Flow ID').fill('leave-request');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish v1' }).click();
  await expect(page).toHaveURL(/#\/flows\/leave-request$/);
  await expect(page.getByText('active: v1')).toBeVisible();
  await page.getByRole('link', { name: '← Flows' }).click();
  await expect(page.getByRole('link', { name: 'Leave request' })).toBeVisible();
});
