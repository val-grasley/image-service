import { isIP } from 'node:net';
import type { Config } from '../config.ts';

type RequestAddressing = {
  remoteAddress: string | undefined;
  headers: (name: string) => string | undefined;
};

type ClientIpConfig = Pick<Config, 'clientIpSource' | 'trustedProxyCount'>;

const UNKNOWN_CLIENT = 'unknown';

export function clientKey(input: RequestAddressing, config: ClientIpConfig): string {
  const address = sourceAddress(input, config);
  if (address === undefined) {
    return UNKNOWN_CLIENT;
  }
  switch (isIP(address)) {
    case 4:
      return address;
    case 6:
      return ipv6Key(address);
    default:
      return UNKNOWN_CLIENT;
  }
}

function sourceAddress(input: RequestAddressing, config: ClientIpConfig): string | undefined {
  switch (config.clientIpSource) {
    case 'socket':
      return input.remoteAddress;
    case 'x-forwarded-for':
      return input
        .headers('x-forwarded-for')
        ?.split(',')
        .at(-1 - config.trustedProxyCount)
        ?.trim();
    case 'cloudfront':
      return viewerAddress(input.headers('cloudfront-viewer-address'));
    default:
      return config.clientIpSource satisfies never;
  }
}

function viewerAddress(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const portSeparator = header.lastIndexOf(':');
  if (portSeparator === -1) {
    return undefined;
  }
  return header.slice(0, portSeparator).replace(/^\[(.*)\]$/, '$1');
}

function ipv6Key(address: string): string {
  const value = ipv6Value(address);
  if (value >> 32n === 0xffffn) {
    // A dual-stack socket reports an IPv4 client as ::ffff:a.b.c.d, whose /64 holds every
    // IPv4 client.
    return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');
  }
  const prefix = [112n, 96n, 80n, 64n].map((shift) => ((value >> shift) & 0xffffn).toString(16));
  return `${prefix.join(':')}::/64`;
}

function ipv6Value(address: string): bigint {
  // A zone index (fe80::1%eth0) names a local interface and is not part of the address.
  const [head = '', tail = ''] = address.replace(/%.*$/, '').split('::');
  const left = hextets(head);
  const right = hextets(tail);
  const gap = new Array<number>(8 - left.length - right.length).fill(0);
  return [...left, ...gap, ...right].reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
}

function hextets(part: string): number[] {
  if (part === '') {
    return [];
  }
  return part.split(':').flatMap((group) => {
    if (!group.includes('.')) {
      return [parseInt(group, 16)];
    }
    const ipv4 = group.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
    return [Math.floor(ipv4 / 0x10000), ipv4 % 0x10000];
  });
}
