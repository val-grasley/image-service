import { expect, test } from '@playwright/test';
import { upstream } from '../stack.ts';

test('shows the loading indicator while the source is delayed, then the result', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Source URL').fill(new URL('/slow?ms=1500', upstream).href);
  await page.getByRole('button', { name: 'Process' }).click();

  const original = page.getByRole('region', { name: 'Original' });
  const processed = page.getByRole('region', { name: 'Processed' });
  await expect(original.getByRole('paragraph')).toHaveText('Loading…');
  await expect(processed.getByRole('paragraph')).toHaveText('Processing…');

  await expect(processed.getByRole('img', { name: 'Processed image' })).toBeVisible();
  await expect(processed.getByRole('paragraph')).toHaveCount(0);
});
