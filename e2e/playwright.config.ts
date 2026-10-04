import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { api, rateLimitedApi, upstream } from './stack.ts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

// Playwright merges process.env into each server's environment, so every variable the specs
// depend on is set here rather than left to whatever the developer's shell exports.
function apiServer(origin: string, rateLimitPerMinute: number) {
  return {
    command: 'node apps/api/src/server.ts',
    cwd: repositoryRoot,
    env: {
      PORT: new URL(origin).port,
      ALLOWED_HOSTS: new URL(upstream).host,
      PUBLIC_HOSTS: '',
      RATE_LIMIT_BACKEND: 'memory',
      RATE_LIMIT_PER_MINUTE: String(rateLimitPerMinute),
      CLIENT_IP_SOURCE: 'socket',
      // Well above the loading spec's 1.5 s upstream delay.
      FETCH_TOTAL_TIMEOUT_MS: '8000',
      LOG_LEVEL: 'warn',
    },
    url: new URL('/health', origin).href,
  };
}

export default defineConfig({
  testDir: 'tests',
  forbidOnly: true,
  fullyParallel: true,
  reporter: 'list',
  // The page formats sizes in the browser's locale, which the size assertions pin.
  use: { baseURL: api, locale: 'en-US', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  webServer: [
    {
      command: `node_modules/.bin/fake-upstream --port ${new URL(upstream).port}`,
      cwd: repositoryRoot,
      url: new URL('/status/200', upstream).href,
    },
    // Far more than the whole suite sends, so no spec but the rate-limit one meets the limit.
    apiServer(api, 1000),
    // Each submit sends /info and /process, so two a minute lets exactly one submit through.
    apiServer(rateLimitedApi, 2),
  ],
});
