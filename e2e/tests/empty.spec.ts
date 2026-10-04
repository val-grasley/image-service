import { expect, test } from '@playwright/test';

test('the empty page shows guidance, no images, and disabled copy buttons', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('region', { name: 'Request' }).getByRole('paragraph')).toHaveText(
    'The request URL and curl command appear here once you submit.',
  );
  await expect(page.getByRole('region', { name: 'Original' }).getByRole('paragraph')).toHaveText(
    'The source image and its metadata appear here.',
  );
  await expect(page.getByRole('region', { name: 'Processed' }).getByRole('paragraph')).toHaveText(
    'The processed image and its metadata appear here.',
  );
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy request URL' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Copy curl command' })).toBeDisabled();
});
