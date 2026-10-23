import { expect, test } from '@playwright/test';

// Clicking a source handle and then a target handle connects them (React Flow's
// click-to-connect). Each click also selects its node; this once made the editor loop.
test('connects nodes by clicking two handles', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^Single level/ }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);

  await page.getByTestId('node-approval').getByTestId('handle-reject').click();
  await page.getByTestId('node-approved').locator('.react-flow__handle-top').click({ force: true });

  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
  await expect(page.locator('.react-flow__edge[data-id="approval:reject"]')).toHaveAttribute(
    'aria-label',
    'Edge from approval to approved',
  );
  await expect(page.getByRole('textbox', { name: 'Node ID' })).toHaveValue('approved');
  expect(errors).toEqual([]);
});
