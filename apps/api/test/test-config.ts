import { parseConfig, type Config } from '../src/config.ts';

// Small enough that a test can exceed any limit cheaply; overrides narrow further per test.
const SMALL_LIMITS = parseConfig({
  MAX_SOURCE_BYTES: '1000000',
  MAX_INPUT_PIXELS: '4000000',
  FETCH_CONNECT_TIMEOUT_MS: '1000',
  FETCH_TOTAL_TIMEOUT_MS: '2000',
  MAX_REDIRECTS: '2',
  TRANSFORM_TIMEOUT_SECONDS: '2',
  MAX_OUTPUT_DIMENSION: '1024',
  MAX_OUTPUT_PIXELS: '1000000',
  MAX_OUTPUT_BYTES: '1000000',
  RESULT_CACHE_MAX_BYTES: '10000000',
  SOURCE_CACHE_MAX_BYTES: '10000000',
});

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...SMALL_LIMITS, ...overrides };
}
