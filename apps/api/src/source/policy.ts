import { BlockList, isIP } from 'node:net';
import type { Config } from '../config.ts';

export type Decision = { allowed: true } | { allowed: false; reason: DenialReason; detail: string };

type DenialReason =
  | 'scheme'
  | 'port'
  | 'userinfo'
  | 'host_name'
  | 'public_host'
  | 'blocked_literal'
  | 'blocked_address'
  | 'downgrade';

export type PolicyConfig = Pick<Config, 'allowedHosts' | 'publicHosts'>;

const BLOCKED_IPV4: readonly (readonly [network: string, prefix: number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

// The IPv4-compatible, NAT64, and 6to4 prefixes are absent: they are blocked only when the
// address they embed is, which embeddedIpv4 decides. IPv4-mapped addresses need no entry
// because BlockList matches them against the IPv4 rules.
const BLOCKED_IPV6: readonly (readonly [network: string, prefix: number])[] = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

// One list per range so a denial can name the range that matched.
const BLOCKED_RANGES = [
  ...BLOCKED_IPV4.map(([network, prefix]) => blockedRange(network, prefix, 'ipv4')),
  ...BLOCKED_IPV6.map(([network, prefix]) => blockedRange(network, prefix, 'ipv6')),
];

type Layout = readonly (readonly [start: bigint, bits: bigint])[];

// Prefixes whose addresses carry an IPv4 address, which is checked against the IPv4 table:
// IPv4-compatible, the two NAT64 prefixes, and 6to4. A layout lists the bit ranges, counted
// from the most significant bit, that hold the IPv4 address. 64:ff9b:1::/48 is a local-use
// NAT64 prefix (RFC 8215) whose operator may pick any RFC 6052 layout of /48 or longer, so
// every such layout is checked, skipping the u octet at bits 64-71.
const IPV4_EMBEDDINGS: readonly { prefix: string; length: bigint; layouts: Layout[] }[] = [
  { prefix: '::', length: 96n, layouts: [[[96n, 32n]]] },
  { prefix: '64:ff9b::', length: 96n, layouts: [[[96n, 32n]]] },
  {
    prefix: '64:ff9b:1::',
    length: 48n,
    layouts: [
      [[96n, 32n]],
      [[72n, 32n]],
      [
        [56n, 8n],
        [72n, 24n],
      ],
      [
        [48n, 16n],
        [72n, 16n],
      ],
    ],
  },
  { prefix: '2002::', length: 16n, layouts: [[[16n, 32n]]] },
];

const LOCAL_SUFFIXES = ['.local', '.internal', '.localhost'];

const ALLOWED: Decision = { allowed: true };

export function checkUrl(url: URL, previous: URL | undefined, policy: PolicyConfig): Decision {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return deny('scheme', `Scheme ${url.protocol.slice(0, -1)} is not allowed; use http or https.`);
  }
  if (url.username !== '' || url.password !== '') {
    return deny('userinfo', 'URLs with credentials are not allowed.');
  }
  const host = normalizedHost(url);
  const port = effectivePort(url);
  const exempt = isExempt(host, port, policy.allowedHosts);
  if (!exempt && port !== 80 && port !== 443) {
    return deny('port', `Port ${String(port)} is not allowed; use 80 or 443.`);
  }
  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return deny('host_name', `Host ${host} is a local name.`);
  }
  if (policy.publicHosts.has(host)) {
    return deny('public_host', `Host ${host} is this service.`);
  }
  if (!exempt && isIP(host) !== 0) {
    const match = matchedRange(host);
    if (match !== undefined) {
      const range =
        match.embedded === undefined ? match.range : `${match.range} (embedded ${match.embedded})`;
      return deny('blocked_literal', `Address ${host} is in blocked range ${range}.`);
    }
  }
  if (previous?.protocol === 'https:' && url.protocol === 'http:') {
    return deny('downgrade', 'A redirect from https to http is not allowed.');
  }
  return ALLOWED;
}

export function checkAddresses(
  url: URL,
  addresses: readonly string[],
  policy: PolicyConfig,
): Decision {
  const host = normalizedHost(url);
  if (isExempt(host, effectivePort(url), policy.allowedHosts)) {
    return ALLOWED;
  }
  // A detail never names the resolved address: inside a VPC that would hand any caller the
  // internal DNS answer. The fetcher logs the addresses for operators.
  for (const address of addresses) {
    if (isIP(address) === 0) {
      return deny(
        'blocked_address',
        `Host ${host} resolves to something that is not an IP address.`,
      );
    }
    const match = matchedRange(address);
    if (match !== undefined) {
      const what = match.embedded === undefined ? 'an address' : 'an address embedding one';
      return deny(
        'blocked_address',
        `Host ${host} resolves to ${what} in blocked range ${match.range}.`,
      );
    }
  }
  return ALLOWED;
}

function deny(reason: DenialReason, detail: string): Decision {
  return { allowed: false, reason, detail };
}

function normalizedHost(url: URL): string {
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

function effectivePort(url: URL): number {
  if (url.port !== '') {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

function isExempt(host: string, port: number, allowedHosts: ReadonlySet<string>): boolean {
  const name = isIP(host) === 6 ? `[${host}]` : host;
  return (
    allowedHosts.has(`${name}:${String(port)}`) ||
    ((port === 80 || port === 443) && allowedHosts.has(name))
  );
}

function blockedRange(
  network: string,
  prefix: number,
  family: 'ipv4' | 'ipv6',
): { range: string; list: BlockList } {
  const list = new BlockList();
  list.addSubnet(network, prefix, family);
  return { range: `${network}/${String(prefix)}`, list };
}

function matchedRange(address: string): { range: string; embedded?: string } | undefined {
  const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
  const direct = BLOCKED_RANGES.find(({ list }) => list.check(address, family));
  if (direct !== undefined) {
    return { range: direct.range };
  }
  if (family === 'ipv4') {
    return undefined;
  }
  for (const embedded of embeddedIpv4(address)) {
    const match = matchedRange(embedded);
    if (match !== undefined) {
      return { range: match.range, embedded };
    }
  }
  return undefined;
}

function embeddedIpv4(address: string): string[] {
  const value = ipv6Value(address);
  const embedding = IPV4_EMBEDDINGS.find(
    ({ prefix, length }) => value >> (128n - length) === ipv6Value(prefix) >> (128n - length),
  );
  return (embedding?.layouts ?? []).map((layout) => {
    const embedded = layout.reduce(
      (ipv4, [start, bits]) =>
        (ipv4 << bits) | ((value >> (128n - start - bits)) & ((1n << bits) - 1n)),
      0n,
    );
    return [24n, 16n, 8n, 0n].map((shift) => String((embedded >> shift) & 0xffn)).join('.');
  });
}

function ipv6Value(address: string): bigint {
  // URL serializes IPv6 in compressed hex with no dotted-quad tail, so only "::" is left to
  // expand. It rejects a zone index, which carries no address bits, so that is dropped first.
  const canonical = new URL(`http://[${address.replace(/%.*$/s, '')}]/`).hostname.slice(1, -1);
  const [head = '', tail = ''] = canonical.split('::');
  const words = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const left = words(head);
  const right = words(tail);
  const zeros = Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].reduce(
    (value, word) => (value << 16n) | BigInt(`0x${word}`),
    0n,
  );
}
