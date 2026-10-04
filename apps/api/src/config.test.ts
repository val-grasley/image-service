import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './config.ts';

describe('parseConfig', () => {
  it('applies every default from the architecture limits table when the environment is empty', () => {
    expect(parseConfig({})).toEqual({
      maxSourceBytes: 15_000_000,
      maxInputPixels: 50_000_000,
      fetchConnectTimeoutMs: 3000,
      fetchTotalTimeoutMs: 8000,
      maxRedirects: 3,
      transformTimeoutSeconds: 5,
      maxOutputDimension: 4096,
      maxOutputPixels: 16_000_000,
      maxOutputBytes: 10_000_000,
      defaultQuality: 80,
      resultCacheTtlSeconds: 3600,
      resultCacheMaxBytes: 100_000_000,
      sourceCacheTtlSeconds: 300,
      sourceCacheMaxBytes: 50_000_000,
      rateLimitPerMinute: 60,
      rateLimitBackend: 'memory',
      rateLimitTable: undefined,
      clientIpSource: 'socket',
      trustedProxyCount: 0,
      publicHosts: new Set(),
      allowedHosts: new Set(),
      logLevel: 'info',
      port: 3000,
    });
  });

  it('coerces numeric strings', () => {
    expect(parseConfig({ MAX_REDIRECTS: '0', PORT: '8080' })).toMatchObject({
      maxRedirects: 0,
      port: 8080,
    });
  });

  it('rejects an invalid value, names the variable, and keeps the Zod error as cause', () => {
    expect(() => parseConfig({ MAX_SOURCE_BYTES: 'lots' })).toThrow(ConfigError);
    expect(() => parseConfig({ DEFAULT_QUALITY: '101' })).toThrow(/DEFAULT_QUALITY/);
    expect(() => parseConfig({ CLIENT_IP_SOURCE: 'header' })).toThrow(/CLIENT_IP_SOURCE/);
    let caught: unknown;
    try {
      parseConfig({ PORT: '-1' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught).toHaveProperty('cause', expect.any(Error));
  });

  it('requires RATE_LIMIT_TABLE when the backend is dynamodb', () => {
    expect(() => parseConfig({ RATE_LIMIT_BACKEND: 'dynamodb' })).toThrow(/RATE_LIMIT_TABLE/);
    expect(
      parseConfig({ RATE_LIMIT_BACKEND: 'dynamodb', RATE_LIMIT_TABLE: 'limits' }).rateLimitTable,
    ).toBe('limits');
  });

  it('parses host lists as lowercased, trimmed, non-empty sets', () => {
    const config = parseConfig({ ALLOWED_HOSTS: ' 127.0.0.1:4000, Example.COM ,, ' });
    expect([...config.allowedHosts]).toEqual(['127.0.0.1:4000', 'example.com']);
  });

  it('removes one trailing dot from the host part of each host-list entry', () => {
    const config = parseConfig({
      ALLOWED_HOSTS: 'Fake.Example.:8080, internal.example., [fd00::1]:4000',
      PUBLIC_HOSTS: 'Self.Example., cdn.example',
    });
    expect([...config.allowedHosts]).toEqual([
      'fake.example:8080',
      'internal.example',
      '[fd00::1]:4000',
    ]);
    expect([...config.publicHosts]).toEqual(['self.example', 'cdn.example']);
  });
});
