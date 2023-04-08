import { expect, test } from '@playwright/test';

test('enter home page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Zero Share');
});

test('enter receiver page', async ({ page }) => {
  await page.goto('/receive?sdp=test');
  await expect(page).toHaveTitle('Zero Share');
});
