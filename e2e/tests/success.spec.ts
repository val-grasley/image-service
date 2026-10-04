import { curlFor, processUrl, type ProcessParams } from '@image-service/sdk';
import { expect, test } from '@playwright/test';
import { api, upstream } from '../stack.ts';

const source = new URL('/image/jpeg?w=640&h=480', upstream).href;

function size(bytes: number): string {
  return `${bytes.toLocaleString('en-US')} bytes`;
}

test('shows both images with their dimensions, format, and size', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Source URL').fill(source);
  await page.getByLabel('Width').fill('320');
  await page.getByLabel('Height').fill('240');
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/process');
  await page.getByRole('button', { name: 'Process' }).click();
  const processedBytes = (await (await answered).body()).byteLength;
  const sourceBytes = (await (await page.request.get(source)).body()).byteLength;

  const original = page.getByRole('region', { name: 'Original' });
  await expect(original.getByRole('img', { name: 'Original image' })).toHaveJSProperty(
    'naturalWidth',
    640,
  );
  await expect(original.getByRole('definition')).toHaveText([
    '640 × 480',
    'jpeg',
    size(sourceBytes),
  ]);

  const processed = page.getByRole('region', { name: 'Processed' });
  await expect(processed.getByRole('img', { name: 'Processed image' })).toHaveJSProperty(
    'naturalWidth',
    320,
  );
  await expect(processed.getByRole('definition')).toHaveText([
    '320 × 240',
    'jpeg',
    size(processedBytes),
  ]);
});

test('converts the processed image to the requested format', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Source URL').fill(source);
  await page.getByLabel('Width').fill('320');
  await page.getByLabel('Format').selectOption('webp');
  await page.getByRole('button', { name: 'Process' }).click();

  const processed = page.getByRole('region', { name: 'Processed' });
  await expect(processed.getByRole('img', { name: 'Processed image' })).toHaveJSProperty(
    'naturalWidth',
    320,
  );
  await expect(processed.getByRole('definition')).toHaveText(['320 × 240', 'webp', /\d bytes$/]);
  await expect(page.getByRole('region', { name: 'Original' }).getByRole('definition')).toHaveText([
    '640 × 480',
    'jpeg',
    /\d bytes$/,
  ]);
});

test.describe('with clipboard access', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('shows the SDK request URL and curl line and copies each', async ({ page }) => {
    const params = {
      url: source,
      width: 300,
      crop: 'fill',
      format: 'webp',
    } satisfies ProcessParams;
    const requestUrl = processUrl(api, params);
    await page.goto('/');
    await page.getByLabel('Source URL').fill(params.url);
    await page.getByLabel('Width').fill(String(params.width));
    await page.getByLabel('Crop').selectOption(params.crop);
    await page.getByLabel('Format').selectOption(params.format);
    await page.getByRole('button', { name: 'Process' }).click();

    await expect(page.getByRole('region', { name: 'Request' }).getByRole('code')).toHaveText([
      requestUrl.href,
      curlFor(requestUrl),
    ]);

    const copyUrl = page.getByRole('button', { name: 'Copy request URL' });
    const copyCurl = page.getByRole('button', { name: 'Copy curl command' });
    await copyUrl.click();
    await expect(copyUrl).toHaveAccessibleDescription('Copied');
    await expect(copyCurl).toHaveAccessibleDescription('');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(requestUrl.href);

    await copyCurl.click();
    await expect(copyCurl).toHaveAccessibleDescription('Copied');
    await expect(copyUrl).toHaveAccessibleDescription('');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(curlFor(requestUrl));

    await expect(copyCurl).toHaveAccessibleDescription('');
  });
});
