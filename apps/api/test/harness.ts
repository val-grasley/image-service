import type { startFakeUpstream } from '@image-service/fake-upstream/server';
import { z } from 'zod';
import { createApp, defaultDeps, type AppDeps } from '../src/app.ts';
import { MemoryResultCache } from '../src/cache/result-cache.ts';
import type { Config } from '../src/config.ts';
import type { AppEnv } from '../src/http/context.ts';
import { createLogger } from '../src/observability/logger.ts';
import { SourceCache } from '../src/source/cache.ts';
import { testConfig } from './test-config.ts';

export type FakeUpstream = Awaited<ReturnType<typeof startFakeUpstream>>;

// Thirty seconds into a minute, so no test's requests straddle a rate-limit window.
const START_MS = Date.UTC(2026, 9, 4, 12, 0, 30);

const logLine = z.record(z.string(), z.unknown());
type LogLine = z.output<typeof logLine>;

const SERVICE_VERSION = '0.0.0-test';

type Caches = Pick<AppDeps, 'resultCache' | 'sourceCache'>;

type HarnessOptions = {
  config?: Partial<Config>;
  pipeline?: AppDeps['pipeline'];
  // Lets a test show that one app's cached entries never bypass another app's URL policy.
  caches?: Caches;
};

type Harness = {
  config: Config;
  serviceVersion: string;
  caches: Caches;
  clock: { time: number; now: () => number };
  request: (path: string, init?: RequestInit, env?: AppEnv['Bindings']) => Promise<Response>;
  logs: () => LogLine[];
};

export function createHarness(fake: FakeUpstream, options: HarnessOptions = {}): Harness {
  const config = testConfig({ allowedHosts: new Set([fake.url.host]), ...options.config });
  const clock = { time: START_MS, now: () => clock.time };
  const lines: string[] = [];
  const base = defaultDeps(config, SERVICE_VERSION);
  const caches = options.caches ?? {
    sourceCache: new SourceCache(config, clock),
    resultCache: new MemoryResultCache(config, clock),
  };
  const app = createApp(
    config,
    {
      ...base,
      ...caches,
      clock,
      logger: createLogger(
        'debug',
        (line) => lines.push(line),
        () => clock.now(),
      ),
      pipeline: options.pipeline ?? base.pipeline,
    },
    SERVICE_VERSION,
  );
  return {
    config,
    serviceVersion: SERVICE_VERSION,
    caches,
    clock,
    // No socket is bound unless a test passes one, as under the Lambda adapter.
    request: async (path, init, env = {}) => app.request(path, init, env),
    logs: () => lines.map((line) => logLine.parse(JSON.parse(line))),
  };
}

export function sourceUrl(fake: FakeUpstream, path: string): string {
  return new URL(path, fake.url).href;
}

export function query(path: string, params: Record<string, string>): string {
  return `${path}?${new URLSearchParams(params).toString()}`;
}
