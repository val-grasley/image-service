import { describe, expect, it } from 'vitest';
import type { Config } from '../config.ts';
import { clientKey } from './client-key.ts';

const cases: {
  name: string;
  source: Config['clientIpSource'];
  trustedProxyCount?: number;
  remoteAddress?: string;
  headers?: Record<string, string>;
  expect: string;
}[] = [
  {
    name: 'socket mode keys on the peer address',
    source: 'socket',
    remoteAddress: '203.0.113.9',
    expect: '203.0.113.9',
  },
  {
    name: 'socket mode ignores forwarding headers',
    source: 'socket',
    remoteAddress: '10.0.0.1',
    headers: { 'X-Forwarded-For': '198.51.100.7', 'CloudFront-Viewer-Address': '198.51.100.7:443' },
    expect: '10.0.0.1',
  },
  {
    name: 'socket mode unmaps an IPv4 client of a dual-stack socket',
    source: 'socket',
    remoteAddress: '::ffff:203.0.113.9',
    expect: '203.0.113.9',
  },
  {
    name: 'socket mode with no peer address, as under the Lambda adapter, yields unknown',
    source: 'socket',
    expect: 'unknown',
  },
  {
    name: 'x-forwarded-for with no trusted proxies takes the rightmost entry',
    source: 'x-forwarded-for',
    trustedProxyCount: 0,
    headers: { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9' },
    expect: '203.0.113.9',
  },
  {
    name: 'x-forwarded-for with one trusted proxy skips the entry that proxy appended',
    source: 'x-forwarded-for',
    trustedProxyCount: 1,
    headers: { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9, 10.0.0.2' },
    expect: '203.0.113.9',
  },
  {
    name: 'x-forwarded-for with fewer entries than trusted proxies yields unknown, never the leftmost',
    source: 'x-forwarded-for',
    trustedProxyCount: 2,
    headers: { 'X-Forwarded-For': '198.51.100.7, 10.0.0.2' },
    expect: 'unknown',
  },
  {
    name: 'x-forwarded-for with the header missing yields unknown',
    source: 'x-forwarded-for',
    remoteAddress: '10.0.0.1',
    expect: 'unknown',
  },
  {
    name: 'x-forwarded-for whose selected entry is not an address yields unknown',
    source: 'x-forwarded-for',
    headers: { 'X-Forwarded-For': '198.51.100.7, unknown' },
    expect: 'unknown',
  },
  {
    name: 'cloudfront strips the port from an IPv4 viewer address',
    source: 'cloudfront',
    headers: { 'CloudFront-Viewer-Address': '203.0.113.9:46532' },
    expect: '203.0.113.9',
  },
  {
    name: 'cloudfront strips the port and brackets from an IPv6 viewer address',
    source: 'cloudfront',
    headers: { 'CloudFront-Viewer-Address': '[2001:db8:aa:bb::1]:443' },
    expect: '2001:db8:aa:bb::/64',
  },
  {
    name: 'cloudfront strips the port from an unbracketed IPv6 viewer address by its last colon',
    source: 'cloudfront',
    headers: { 'CloudFront-Viewer-Address': '2001:db8:aa:bb:1:2:3:4:46532' },
    expect: '2001:db8:aa:bb::/64',
  },
  {
    name: 'cloudfront ignores X-Forwarded-For',
    source: 'cloudfront',
    headers: { 'CloudFront-Viewer-Address': '203.0.113.9:443', 'X-Forwarded-For': '198.51.100.7' },
    expect: '203.0.113.9',
  },
  {
    name: 'cloudfront with the header missing yields unknown',
    source: 'cloudfront',
    remoteAddress: '10.0.0.1',
    expect: 'unknown',
  },
  {
    name: 'cloudfront with a viewer address that has no port yields unknown',
    source: 'cloudfront',
    headers: { 'CloudFront-Viewer-Address': '203.0.113.9' },
    expect: 'unknown',
  },
  {
    name: 'an IPv6 address masks to its /64',
    source: 'socket',
    remoteAddress: '2001:db8:aa:bb:1:2:3:4',
    expect: '2001:db8:aa:bb::/64',
  },
  {
    name: 'another address in the same /64 shares its key',
    source: 'socket',
    remoteAddress: '2001:db8:aa:bb:ffff:ffff:ffff:ffff',
    expect: '2001:db8:aa:bb::/64',
  },
  {
    name: 'an IPv6 address in uppercase with leading zeros keys in canonical form',
    source: 'socket',
    remoteAddress: '2001:0DB8:0000:00AA::1',
    expect: '2001:db8:0:aa::/64',
  },
  {
    name: 'an IPv6 address with a zone index masks without it',
    source: 'socket',
    remoteAddress: 'fe80::1%eth0',
    expect: 'fe80:0:0:0::/64',
  },
  {
    name: 'an IPv6 address with an embedded IPv4 suffix that is not IPv4-mapped masks to its /64',
    source: 'socket',
    remoteAddress: '64:ff9b::198.51.100.7',
    expect: '64:ff9b:0:0::/64',
  },
  {
    name: 'an IPv4-mapped address written in full hextets unmaps to IPv4',
    source: 'socket',
    remoteAddress: '0:0:0:0:0:ffff:cb00:7109',
    expect: '203.0.113.9',
  },
];

describe('clientKey', () => {
  for (const c of cases) {
    it(c.name, () => {
      const headers = new Headers(c.headers);
      const key = clientKey(
        { remoteAddress: c.remoteAddress, headers: (name) => headers.get(name) ?? undefined },
        { clientIpSource: c.source, trustedProxyCount: c.trustedProxyCount ?? 0 },
      );
      expect(key).toBe(c.expect);
    });
  }
});
