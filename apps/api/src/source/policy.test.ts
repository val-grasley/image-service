import { describe, expect, it } from 'vitest';
import { checkAddresses, checkUrl, type Decision, type PolicyConfig } from './policy.ts';

type Reason = Extract<Decision, { allowed: false }>['reason'];

const policy: PolicyConfig = {
  allowedHosts: new Set([
    '127.0.0.1:4000',
    '192.168.5.5:443',
    '10.1.2.3',
    '[fd00::1]:4000',
    'internal.example',
    'staging.example:8080',
    'localhost',
    'localhost:4000',
    'images.example',
  ]),
  publicHosts: new Set(['images.example']),
};

const allowed: Decision = { allowed: true };

function denied(reason: Reason, detail: string): Decision {
  return { allowed: false, reason, detail };
}

function literal(host: string, range: string): Decision {
  return denied('blocked_literal', `Address ${host} is in blocked range ${range}.`);
}

function resolvesTo(host: string, range: string): Decision {
  return {
    allowed: false,
    reason: 'blocked_address',
    detail: `Host ${host} resolves to a private or reserved address.`,
    range,
  };
}

type UrlCase = { name: string; url: string; previous?: string; expect: Decision };

function urlCases(cases: UrlCase[]): void {
  for (const c of cases) {
    it(c.name, () => {
      const previous = c.previous === undefined ? undefined : new URL(c.previous);
      expect(checkUrl(new URL(c.url), previous, policy)).toEqual(c.expect);
    });
  }
}

describe('checkUrl', () => {
  describe('scheme and form', () => {
    urlCases([
      {
        name: 'denies ftp',
        url: 'ftp://example.com/a.jpg',
        expect: denied('scheme', 'Scheme ftp is not allowed; use http or https.'),
      },
      {
        name: 'denies file',
        url: 'file:///etc/passwd',
        expect: denied('scheme', 'Scheme file is not allowed; use http or https.'),
      },
      {
        name: 'denies data',
        url: 'data:image/png;base64,iVBORw0KGgo=',
        expect: denied('scheme', 'Scheme data is not allowed; use http or https.'),
      },
      {
        name: 'denies javascript',
        url: 'javascript:alert(1)',
        expect: denied('scheme', 'Scheme javascript is not allowed; use http or https.'),
      },
      { name: 'allows http', url: 'http://example.com/a.jpg', expect: allowed },
      { name: 'allows https', url: 'https://example.com/a.jpg?w=1', expect: allowed },
      {
        name: 'denies port 8080',
        url: 'http://example.com:8080/',
        expect: denied('port', 'Port 8080 is not allowed; use 80 or 443.'),
      },
      {
        name: 'denies port 8443',
        url: 'https://example.com:8443/',
        expect: denied('port', 'Port 8443 is not allowed; use 80 or 443.'),
      },
      {
        name: 'denies port 22',
        url: 'http://example.com:22/',
        expect: denied('port', 'Port 22 is not allowed; use 80 or 443.'),
      },
      {
        name: 'denies port 0',
        url: 'http://example.com:0/',
        expect: denied('port', 'Port 0 is not allowed; use 80 or 443.'),
      },
      { name: 'allows an explicit port 80', url: 'http://example.com:80/', expect: allowed },
      { name: 'allows an explicit port 443', url: 'https://example.com:443/', expect: allowed },
      {
        name: 'denies a user and password',
        url: 'http://user:pw@example.com/',
        expect: denied('userinfo', 'URLs with credentials are not allowed.'),
      },
      {
        name: 'denies a user without a password',
        url: 'http://user@example.com/',
        expect: denied('userinfo', 'URLs with credentials are not allowed.'),
      },
      {
        name: 'denies a password without a user',
        url: 'http://:pw@example.com/',
        expect: denied('userinfo', 'URLs with credentials are not allowed.'),
      },
    ]);
  });

  describe('rule order', () => {
    urlCases([
      {
        name: 'reports the scheme before userinfo, port, and name',
        url: 'ftp://user@localhost:21/',
        expect: denied('scheme', 'Scheme ftp is not allowed; use http or https.'),
      },
      {
        name: 'reports userinfo before port and name',
        url: 'http://user@localhost:8080/',
        expect: denied('userinfo', 'URLs with credentials are not allowed.'),
      },
      {
        name: 'reports the port before the name',
        url: 'http://a.internal:8080/',
        expect: denied('port', 'Port 8080 is not allowed; use 80 or 443.'),
      },
      {
        name: 'reports a blocked literal before a downgrade',
        url: 'http://192.168.0.1/',
        previous: 'https://example.com/',
        expect: literal('192.168.0.1', '192.168.0.0/16'),
      },
    ]);
  });

  describe('names', () => {
    urlCases([
      {
        name: 'denies localhost',
        url: 'http://localhost/',
        expect: denied('host_name', 'Host localhost is a local name.'),
      },
      {
        name: 'denies LOCALHOST after lowercasing',
        url: 'http://LOCALHOST/',
        expect: denied('host_name', 'Host localhost is a local name.'),
      },
      {
        name: 'denies localhost. after removing the trailing dot',
        url: 'http://localhost./',
        expect: denied('host_name', 'Host localhost is a local name.'),
      },
      {
        name: 'denies a .local name',
        url: 'http://a.local/',
        expect: denied('host_name', 'Host a.local is a local name.'),
      },
      {
        name: 'denies a .internal name',
        url: 'http://a.internal/',
        expect: denied('host_name', 'Host a.internal is a local name.'),
      },
      {
        name: 'denies a .localhost name',
        url: 'http://a.localhost/',
        expect: denied('host_name', 'Host a.localhost is a local name.'),
      },
      {
        name: 'allows a name ending in localhost without its dot',
        url: 'http://alocalhost/',
        expect: allowed,
      },
      {
        name: 'allows a name ending in local without its dot',
        url: 'http://alocal/',
        expect: allowed,
      },
      {
        name: 'allows a name ending in internal without its dot',
        url: 'http://ainternal/',
        expect: allowed,
      },
      {
        name: 'allows a name with a local label first',
        url: 'http://local.example/',
        expect: allowed,
      },
      {
        name: 'denies a PUBLIC_HOSTS name',
        url: 'https://images.example/a.jpg',
        expect: denied('public_host', 'Host images.example is this service.'),
      },
      {
        name: 'denies a PUBLIC_HOSTS name in upper case',
        url: 'https://IMAGES.EXAMPLE/a.jpg',
        expect: denied('public_host', 'Host images.example is this service.'),
      },
      {
        name: 'denies a PUBLIC_HOSTS name with a trailing dot',
        url: 'https://images.example./a.jpg',
        expect: denied('public_host', 'Host images.example is this service.'),
      },
      {
        name: 'denies localhost although ALLOWED_HOSTS lists it',
        url: 'http://localhost/',
        expect: denied('host_name', 'Host localhost is a local name.'),
      },
      {
        name: 'denies localhost although ALLOWED_HOSTS lists it with this port',
        url: 'http://localhost:4000/',
        expect: denied('host_name', 'Host localhost is a local name.'),
      },
    ]);
  });

  describe('IPv4 literals', () => {
    urlCases([
      { name: 'denies 0.0.0.0/8', url: 'http://0.1.2.3/', expect: literal('0.1.2.3', '0.0.0.0/8') },
      {
        name: 'denies 10.0.0.0/8',
        url: 'http://10.20.30.40/',
        expect: literal('10.20.30.40', '10.0.0.0/8'),
      },
      {
        name: 'denies the bottom of 100.64.0.0/10',
        url: 'http://100.64.0.1/',
        expect: literal('100.64.0.1', '100.64.0.0/10'),
      },
      {
        name: 'denies the top of 100.64.0.0/10',
        url: 'http://100.127.255.254/',
        expect: literal('100.127.255.254', '100.64.0.0/10'),
      },
      { name: 'allows just below 100.64.0.0/10', url: 'http://100.63.255.255/', expect: allowed },
      { name: 'allows just above 100.64.0.0/10', url: 'http://100.128.0.1/', expect: allowed },
      {
        name: 'denies 127.0.0.0/8',
        url: 'http://127.0.0.1/',
        expect: literal('127.0.0.1', '127.0.0.0/8'),
      },
      {
        name: 'denies 169.254.0.0/16, the metadata address',
        url: 'http://169.254.169.254/latest/meta-data/',
        expect: literal('169.254.169.254', '169.254.0.0/16'),
      },
      {
        name: 'denies the bottom of 172.16.0.0/12',
        url: 'http://172.16.0.1/',
        expect: literal('172.16.0.1', '172.16.0.0/12'),
      },
      {
        name: 'denies the top of 172.16.0.0/12',
        url: 'http://172.31.255.255/',
        expect: literal('172.31.255.255', '172.16.0.0/12'),
      },
      { name: 'allows just below 172.16.0.0/12', url: 'http://172.15.255.255/', expect: allowed },
      { name: 'allows just above 172.16.0.0/12', url: 'http://172.32.0.1/', expect: allowed },
      {
        name: 'denies 192.0.0.0/24',
        url: 'http://192.0.0.8/',
        expect: literal('192.0.0.8', '192.0.0.0/24'),
      },
      { name: 'allows just above 192.0.0.0/24', url: 'http://192.0.1.1/', expect: allowed },
      {
        name: 'denies 192.168.0.0/16',
        url: 'http://192.168.1.1/',
        expect: literal('192.168.1.1', '192.168.0.0/16'),
      },
      {
        name: 'denies the bottom of 198.18.0.0/15',
        url: 'http://198.18.0.1/',
        expect: literal('198.18.0.1', '198.18.0.0/15'),
      },
      {
        name: 'denies the top of 198.18.0.0/15',
        url: 'http://198.19.255.255/',
        expect: literal('198.19.255.255', '198.18.0.0/15'),
      },
      { name: 'allows just above 198.18.0.0/15', url: 'http://198.20.0.1/', expect: allowed },
      {
        name: 'denies the bottom of 224.0.0.0/4',
        url: 'http://224.0.0.1/',
        expect: literal('224.0.0.1', '224.0.0.0/4'),
      },
      {
        name: 'denies the top of 224.0.0.0/4',
        url: 'http://239.255.255.255/',
        expect: literal('239.255.255.255', '224.0.0.0/4'),
      },
      {
        name: 'denies 240.0.0.0/4',
        url: 'http://240.0.0.1/',
        expect: literal('240.0.0.1', '240.0.0.0/4'),
      },
      {
        name: 'denies the broadcast address',
        url: 'http://255.255.255.255/',
        expect: literal('255.255.255.255', '240.0.0.0/4'),
      },
      { name: 'allows a public address', url: 'http://8.8.8.8/', expect: allowed },
      { name: 'allows the top of public space', url: 'http://223.255.255.255/', expect: allowed },
    ]);

    for (const form of ['127.1', '0177.0.0.1', '0x7f.0.0.1', '2130706433']) {
      it(`canonicalizes ${form} to 127.0.0.1 and denies it`, () => {
        const url = new URL(`http://${form}/`);
        expect(url.hostname).toBe('127.0.0.1');
        expect(checkUrl(url, undefined, policy)).toEqual(literal('127.0.0.1', '127.0.0.0/8'));
      });
    }
  });

  describe('IPv6 literals', () => {
    urlCases([
      { name: 'denies [::1]', url: 'http://[::1]/', expect: literal('::1', '::1/128') },
      { name: 'denies [::]', url: 'http://[::]/', expect: literal('::', '::/128') },
      {
        name: 'denies IPv4-mapped loopback in dotted form',
        url: 'http://[::ffff:127.0.0.1]/',
        expect: literal('::ffff:7f00:1', '127.0.0.0/8'),
      },
      {
        name: 'denies IPv4-mapped loopback in hex form',
        url: 'http://[::ffff:7f00:1]/',
        expect: literal('::ffff:7f00:1', '127.0.0.0/8'),
      },
      {
        name: 'denies IPv4-mapped private space',
        url: 'http://[::ffff:10.0.0.1]/',
        expect: literal('::ffff:a00:1', '10.0.0.0/8'),
      },
      { name: 'allows IPv4-mapped public space', url: 'http://[::ffff:8.8.8.8]/', expect: allowed },
      {
        name: 'denies IPv4-compatible loopback',
        url: 'http://[::127.0.0.1]/',
        expect: literal('::7f00:1', '127.0.0.0/8 (embedded 127.0.0.1)'),
      },
      { name: 'allows IPv4-compatible public space', url: 'http://[::808:808]/', expect: allowed },
      {
        name: 'denies NAT64 64:ff9b::/96 loopback',
        url: 'http://[64:ff9b::7f00:1]/',
        expect: literal('64:ff9b::7f00:1', '127.0.0.0/8 (embedded 127.0.0.1)'),
      },
      {
        name: 'allows NAT64 64:ff9b::/96 public space',
        url: 'http://[64:ff9b::808:808]/',
        expect: allowed,
      },
      {
        name: 'denies NAT64 64:ff9b:1::/48 loopback as the whole prefix',
        url: 'http://[64:ff9b:1::7f00:1]/',
        expect: literal('64:ff9b:1::7f00:1', '64:ff9b:1::/48'),
      },
      {
        name: 'denies NAT64 64:ff9b:1::/48 public in every RFC 6052 layout, which passed before',
        url: 'http://[64:ff9b:1:808:8:808:808:808]/',
        expect: literal('64:ff9b:1:808:8:808:808:808', '64:ff9b:1::/48'),
      },
      {
        name: 'denies the top of 64:ff9b:1::/48',
        url: 'http://[64:ff9b:1:ffff:ffff:ffff:ffff:ffff]/',
        expect: literal('64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '64:ff9b:1::/48'),
      },
      {
        name: 'allows the /48 after 64:ff9b:1::/48',
        url: 'http://[64:ff9b:2::1]/',
        expect: allowed,
      },
      {
        name: 'denies IPv4-translated loopback, which passed before',
        url: 'http://[::ffff:0:127.0.0.1]/',
        expect: literal('::ffff:0:7f00:1', '127.0.0.0/8 (embedded 127.0.0.1)'),
      },
      {
        name: 'denies IPv4-translated metadata address',
        url: 'http://[::ffff:0:a9fe:a9fe]/',
        expect: literal('::ffff:0:a9fe:a9fe', '169.254.0.0/16 (embedded 169.254.169.254)'),
      },
      {
        name: 'allows IPv4-translated public space',
        url: 'http://[::ffff:0:808:808]/',
        expect: allowed,
      },
      {
        name: 'denies a Teredo address, which passed before',
        url: 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/',
        expect: literal('2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::/32'),
      },
      {
        name: 'denies the top of 2001::/32',
        url: 'http://[2001:0:ffff:ffff:ffff:ffff:ffff:ffff]/',
        expect: literal('2001:0:ffff:ffff:ffff:ffff:ffff:ffff', '2001::/32'),
      },
      {
        name: 'denies the benchmarking prefix 2001:2::/48',
        url: 'http://[2001:2::1]/',
        expect: literal('2001:2::1', '2001:2::/48'),
      },
      {
        name: 'denies the top of 2001:2::/48',
        url: 'http://[2001:2:0:ffff:ffff:ffff:ffff:ffff]/',
        expect: literal('2001:2:0:ffff:ffff:ffff:ffff:ffff', '2001:2::/48'),
      },
      { name: 'allows the /48 after 2001:2::/48', url: 'http://[2001:2:1::1]/', expect: allowed },
      {
        name: 'denies the discard-only prefix 100::/64',
        url: 'http://[100::1]/',
        expect: literal('100::1', '100::/64'),
      },
      {
        name: 'denies the top of 100::/64',
        url: 'http://[100::ffff:ffff:ffff:ffff]/',
        expect: literal('100::ffff:ffff:ffff:ffff', '100::/64'),
      },
      { name: 'allows the /64 after 100::/64', url: 'http://[100:0:0:1::1]/', expect: allowed },
      {
        name: 'allows public space just above 2001::/32',
        url: 'http://[2001:1::1]/',
        expect: allowed,
      },
      {
        name: 'denies 6to4 loopback',
        url: 'http://[2002:7f00:1::]/',
        expect: literal('2002:7f00:1::', '127.0.0.0/8 (embedded 127.0.0.1)'),
      },
      {
        name: 'denies 6to4 of the metadata address',
        url: 'http://[2002:a9fe:a9fe::1]/',
        expect: literal('2002:a9fe:a9fe::1', '169.254.0.0/16 (embedded 169.254.169.254)'),
      },
      { name: 'allows 6to4 public space', url: 'http://[2002:808:808::]/', expect: allowed },
      { name: 'denies fc00::/7', url: 'http://[fc00::1]/', expect: literal('fc00::1', 'fc00::/7') },
      {
        name: 'denies the fd half of fc00::/7',
        url: 'http://[fd12:3456::1]/',
        expect: literal('fd12:3456::1', 'fc00::/7'),
      },
      {
        name: 'denies fe80::/10',
        url: 'http://[fe80::1]/',
        expect: literal('fe80::1', 'fe80::/10'),
      },
      {
        name: 'denies the top of fe80::/10',
        url: 'http://[febf::1]/',
        expect: literal('febf::1', 'fe80::/10'),
      },
      {
        name: 'denies fec0::/10',
        url: 'http://[fec0::1]/',
        expect: literal('fec0::1', 'fec0::/10'),
      },
      { name: 'denies ff00::/8', url: 'http://[ff02::1]/', expect: literal('ff02::1', 'ff00::/8') },
      { name: 'allows a public IPv6 address', url: 'http://[2606:4700::1111]/', expect: allowed },
    ]);
  });

  describe('ALLOWED_HOSTS', () => {
    urlCases([
      {
        name: 'exempts a host:port entry from the port and IP-literal rules',
        url: 'http://127.0.0.1:4000/',
        expect: allowed,
      },
      {
        name: 'does not exempt another port of a host:port entry',
        url: 'http://127.0.0.1:4001/',
        expect: denied('port', 'Port 4001 is not allowed; use 80 or 443.'),
      },
      {
        name: 'does not exempt port 80 of a host:port entry from the IP-literal rule',
        url: 'http://127.0.0.1/',
        expect: literal('127.0.0.1', '127.0.0.0/8'),
      },
      {
        name: 'exempts a host:443 entry on an https URL with the port implied',
        url: 'https://192.168.5.5/',
        expect: allowed,
      },
      {
        name: 'does not exempt a host:443 entry on an http URL with the port implied',
        url: 'http://192.168.5.5/',
        expect: literal('192.168.5.5', '192.168.0.0/16'),
      },
      {
        name: 'exempts an IPv6 host:port entry',
        url: 'http://[fd00::1]:4000/',
        expect: allowed,
      },
      {
        name: 'does not exempt port 80 of an IPv6 host:port entry',
        url: 'http://[fd00::1]/',
        expect: literal('fd00::1', 'fc00::/7'),
      },
      { name: 'exempts a portless entry on 80', url: 'http://10.1.2.3/', expect: allowed },
      { name: 'exempts a portless entry on 443', url: 'https://10.1.2.3/', expect: allowed },
      {
        name: 'does not exempt a portless entry from the port rule',
        url: 'http://10.1.2.3:8080/',
        expect: denied('port', 'Port 8080 is not allowed; use 80 or 443.'),
      },
      {
        name: 'exempts a name:port entry from the port rule',
        url: 'http://staging.example:8080/',
        expect: allowed,
      },
      {
        name: 'does not exempt a listed host from the scheme rule',
        url: 'ftp://127.0.0.1:4000/',
        expect: denied('scheme', 'Scheme ftp is not allowed; use http or https.'),
      },
      {
        name: 'does not exempt a listed host from the userinfo rule',
        url: 'http://user@127.0.0.1:4000/',
        expect: denied('userinfo', 'URLs with credentials are not allowed.'),
      },
      {
        name: 'does not exempt a listed host from PUBLIC_HOSTS',
        url: 'http://images.example/',
        expect: denied('public_host', 'Host images.example is this service.'),
      },
      {
        name: 'does not exempt a listed host from the downgrade rule',
        url: 'http://127.0.0.1:4000/',
        previous: 'https://example.com/',
        expect: denied('downgrade', 'A redirect from https to http is not allowed.'),
      },
    ]);
  });

  describe('downgrade', () => {
    urlCases([
      {
        name: 'denies an https previous hop followed by http',
        url: 'http://example.com/a.jpg',
        previous: 'https://example.com/a.jpg',
        expect: denied('downgrade', 'A redirect from https to http is not allowed.'),
      },
      {
        name: 'allows an http previous hop followed by https',
        url: 'https://example.com/a.jpg',
        previous: 'http://example.com/a.jpg',
        expect: allowed,
      },
      {
        name: 'allows an http previous hop followed by http',
        url: 'http://cdn.example/a.jpg',
        previous: 'http://example.com/a.jpg',
        expect: allowed,
      },
    ]);
  });
});

const blockedResolutions: [address: string, range: string][] = [
  ['0.0.0.1', '0.0.0.0/8'],
  ['10.0.0.1', '10.0.0.0/8'],
  ['100.64.0.1', '100.64.0.0/10'],
  ['127.0.0.1', '127.0.0.0/8'],
  ['169.254.169.254', '169.254.0.0/16'],
  ['172.16.0.1', '172.16.0.0/12'],
  ['192.0.0.1', '192.0.0.0/24'],
  ['192.168.0.1', '192.168.0.0/16'],
  ['198.18.0.1', '198.18.0.0/15'],
  ['224.0.0.1', '224.0.0.0/4'],
  ['240.0.0.1', '240.0.0.0/4'],
  ['::', '::/128'],
  ['::1', '::1/128'],
  ['::ffff:127.0.0.1', '127.0.0.0/8'],
  ['::127.0.0.1', '127.0.0.0/8'],
  ['64:ff9b::a00:1', '10.0.0.0/8'],
  ['64:ff9b:1::a00:1', '64:ff9b:1::/48'],
  ['64:ff9b:1:808:8:808:808:808', '64:ff9b:1::/48'],
  ['::ffff:0:a00:1', '10.0.0.0/8'],
  ['2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::/32'],
  ['2001:2::1', '2001:2::/48'],
  ['100::1', '100::/64'],
  ['2002:a00:1::', '10.0.0.0/8'],
  ['fc00::1', 'fc00::/7'],
  ['fe80::1', 'fe80::/10'],
  ['fe80::1%eth0', 'fe80::/10'],
  ['2002:a00:1::%eth0', '10.0.0.0/8'],
  ['fec0::1', 'fec0::/10'],
  ['ff02::1', 'ff00::/8'],
];

describe('checkAddresses', () => {
  const cases: { name: string; url: string; addresses: string[]; expect: Decision }[] = [
    ...blockedResolutions.map(([address, range]) => ({
      name: `denies a public name resolving to ${address}, naming ${range} only outside the detail`,
      url: 'https://photos.example/a.jpg',
      addresses: [address],
      expect: resolvesTo('photos.example', range),
    })),
    {
      name: 'allows a name resolving to public IPv4 and IPv6 addresses',
      url: 'https://photos.example/a.jpg',
      addresses: ['203.0.113.10', '2606:4700::1111'],
      expect: allowed,
    },
    {
      name: 'denies a resolution that is not an IP address',
      url: 'https://photos.example/a.jpg',
      addresses: ['photos.example'],
      expect: denied(
        'blocked_address',
        'Host photos.example resolves to something that is not an IP address.',
      ),
    },
    {
      name: 'denies when one of several addresses is private',
      url: 'https://photos.example/a.jpg',
      addresses: ['203.0.113.10', '10.0.0.1', '203.0.113.11'],
      expect: resolvesTo('photos.example', '10.0.0.0/8'),
    },
    {
      name: 'allows a host:port entry to reach loopback on that port',
      url: 'http://127.0.0.1:4000/a.jpg',
      addresses: ['127.0.0.1'],
      expect: allowed,
    },
    {
      name: 'denies a host:port entry on another port',
      url: 'http://127.0.0.1:4001/a.jpg',
      addresses: ['127.0.0.1'],
      expect: resolvesTo('127.0.0.1', '127.0.0.0/8'),
    },
    {
      name: 'allows a portless entry on 443',
      url: 'https://internal.example/a.jpg',
      addresses: ['10.0.0.5'],
      expect: allowed,
    },
    {
      name: 'allows a portless entry on 80 in upper case with a trailing dot',
      url: 'http://INTERNAL.example./a.jpg',
      addresses: ['10.0.0.5'],
      expect: allowed,
    },
    {
      name: 'denies a portless entry on a high port',
      url: 'https://internal.example:8443/a.jpg',
      addresses: ['10.0.0.5'],
      expect: resolvesTo('internal.example', '10.0.0.0/8'),
    },
    {
      name: 'allows a name:port entry on its port',
      url: 'http://staging.example:8080/a.jpg',
      addresses: ['10.0.0.6'],
      expect: allowed,
    },
    {
      name: 'denies a name:port entry on the default port',
      url: 'http://staging.example/a.jpg',
      addresses: ['10.0.0.6'],
      expect: resolvesTo('staging.example', '10.0.0.0/8'),
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(checkAddresses(new URL(c.url), c.addresses, policy)).toEqual(c.expect);
    });
  }
});
