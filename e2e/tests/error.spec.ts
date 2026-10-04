import assert from 'node:assert/strict';
import type { ErrorCode } from '@image-service/sdk';
import { expect, test, type Page } from '@playwright/test';
import { rateLimitedApi, upstream } from '../stack.ts';

const source = new URL('/image/jpeg?w=640&h=480', upstream).href;

type ExpectedProblem = { status: number; title: string; detail: string | RegExp; code: ErrorCode };

async function submitAndExpectProblem(page: Page, problem: ExpectedProblem): Promise<void> {
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/process');
  await page.getByRole('button', { name: 'Process' }).click();
  const response = await answered;
  expect(response.status()).toBe(problem.status);
  const requestId = await response.headerValue('x-request-id');
  assert(requestId !== null, 'the API sends X-Request-Id with every problem');

  const processed = page.getByRole('region', { name: 'Processed' });
  await expect(processed.getByRole('paragraph')).toHaveText([problem.title, problem.detail]);
  await expect(processed.getByRole('definition')).toHaveText([problem.code, requestId]);
  await expect(page.getByRole('region', { name: 'Original' }).getByRole('paragraph')).toHaveText(
    'No source image for this request.',
  );
}

const sourceCases: { name: string; url: string; problem: ExpectedProblem }[] = [
  {
    name: 'a private address shows the 403 problem',
    url: 'http://10.0.0.1/cat.jpg',
    problem: {
      status: 403,
      title: 'URL not allowed',
      detail: 'Address 10.0.0.1 is in blocked range 10.0.0.0/8.',
      code: 'url_not_allowed',
    },
  },
  {
    name: 'a non-image source shows the 415 problem',
    url: new URL('/html', upstream).href,
    problem: {
      status: 415,
      title: 'Unsupported source type',
      detail: 'The source is not a JPEG, PNG, WebP, GIF, AVIF, or TIFF image.',
      code: 'unsupported_source_type',
    },
  },
  {
    name: 'a source answering with an error status shows the 502 problem',
    url: new URL('/status/404', upstream).href,
    problem: {
      status: 502,
      title: 'Upstream error',
      detail: 'The source responded with status 404.',
      code: 'upstream_error',
    },
  },
];

for (const c of sourceCases) {
  test(c.name, async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Source URL').fill(c.url);
    await submitAndExpectProblem(page, c.problem);
  });
}

test('a request that gets no response shows the transport failure', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Source URL').fill(source);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Process' }).click();

  await expect(page.getByRole('region', { name: 'Processed' }).getByRole('paragraph')).toHaveText([
    'The request did not complete.',
    'The request to the image service failed.',
  ]);
  await expect(page.getByRole('region', { name: 'Original' }).getByRole('paragraph')).toHaveText(
    'No source image for this request.',
  );
});

test('a validation error shows the problem and the field error beside its input', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Source URL').fill(source);
  await page.getByLabel('Quality').fill('0');
  await submitAndExpectProblem(page, {
    status: 400,
    title: 'Invalid parameter',
    detail: 'Invalid query parameters: quality.',
    code: 'invalid_parameter',
  });

  const quality = page.getByLabel('Quality');
  await expect(quality).toHaveAccessibleDescription('must be an integer between 1 and 100');
  await expect(quality).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Width')).toHaveAttribute('aria-invalid', 'false');
});

test.describe('on the rate-limited instance', () => {
  test.use({ baseURL: rateLimitedApi });

  test('a request past the per-minute limit shows the 429 problem', async ({ page }) => {
    // The limiter counts in fixed windows aligned to the minute, so a start just before a
    // boundary would put the third request in a fresh window.
    await expect.poll(() => new Date().getUTCSeconds(), { timeout: 10_000 }).toBeLessThan(55);
    await page.goto('/');
    await page.getByLabel('Source URL').fill(source);
    await page.getByRole('button', { name: 'Process' }).click();
    await expect(
      page.getByRole('region', { name: 'Processed' }).getByRole('img', { name: 'Processed image' }),
    ).toBeVisible();

    // A changed parameter, since the browser would answer an identical URL from its cache.
    await page.getByLabel('Width').fill('32');
    await submitAndExpectProblem(page, {
      status: 429,
      title: 'Rate limited',
      detail: /^More than 2 requests in this minute; retry after \d+ s\.$/,
      code: 'rate_limited',
    });
  });
});
