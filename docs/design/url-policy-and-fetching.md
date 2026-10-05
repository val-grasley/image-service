# Design: URL policy and fetching

Implements `docs/architecture.md` section 5. The rules there are normative; this document
fixes the module interfaces, the mechanics that make the rules hold, and the test table.
Directory: `apps/api/src/source/`.

## Modules

| File | Responsibility |
|---|---|
| `policy.ts` | Pure decisions over a parsed URL and a list of resolved addresses |
| `fetcher.ts` | The only outbound network I/O: resolve, pin, connect, follow redirects, cap bytes |
| `sniff.ts` | Content type from magic bytes |
| `cache.ts` | Short-TTL cache of fetched sources keyed by URL |

Errors thrown by this directory are `ServiceError` instances (`apps/api/src/errors.ts`)
carrying an SDK error code. The HTTP layer maps codes to statuses; nothing here knows about
HTTP responses.

## policy.ts

```ts
type Decision =
  | { allowed: true }
  | { allowed: false; reason: DenialReason; detail: string };

type DenialReason =
  | 'scheme' | 'port' | 'userinfo' | 'host_name' | 'public_host'
  | 'blocked_literal' | 'blocked_address' | 'downgrade';

function checkUrl(url: URL, previous: URL | undefined, policy: PolicyConfig): Decision;
function checkAddresses(url: URL, addresses: readonly string[], policy: PolicyConfig): Decision;
```

`PolicyConfig` is the slice of `Config` holding `allowedHosts` and `publicHosts`, each a
`ReadonlySet<string>` of lowercased entries. `previous` is the prior hop during a redirect
chain, used for the https-to-http downgrade check only.

`checkUrl` applies the URL rules of section 5 in this order: scheme, userinfo, port, host
name, `PUBLIC_HOSTS`, IP literal, downgrade. The first failing rule is the reported reason.
`ALLOWED_HOSTS` is consulted before the port and IP-literal rules, with the exemption
semantics in section 5.

`checkAddresses` applies the address rules to every address; one blocked address denies,
and so does a string that is not an IP address, since the fetcher could not connect to it as
checked. `ALLOWED_HOSTS` exempts the host from this check. A blocked address's `detail` is
the fixed category `Host <hostname> resolves to a private or reserved address.`, naming
neither the address, nor an embedded one, nor the range: inside a VPC the address is an
internal DNS answer and the range tells which private plan the name lives in (decision 57).
The range that matched (for an embedding prefix, the IPv4 range of the embedded address)
travels in the decision's `range` field, which only the log reads. An IP-literal denial from
`checkUrl` names the literal and its range, since the literal is the caller's own input.

**Range checks** use `node:net` `BlockList`, built once per process from the two tables in
section 5, one `BlockList` per range so that a denial can name the range that matched (in
`detail` for a literal, in `range` for an address). IPv4 ranges are added with
`addSubnet(..., 'ipv4')` and IPv6 ranges with `addSubnet(..., 'ipv6')`.
`check` is called with the address family as its second argument (`'ipv6'` for any IPv6
literal); with the family omitted an IPv6 input is never matched. `BlockList` matches
IPv4-mapped addresses (`::ffff:a.b.c.d`) against IPv4 rules when checked as `'ipv6'`, and
matches addresses carrying a zone index (`fe80::1%eth0`). For the other four embedding
prefixes (IPv4-compatible `::/96`, IPv4-translated `::ffff:0:0:0/96`, NAT64 `64:ff9b::/96`,
6to4 `2002::/16`), `embeddedIpv4(address)` extracts the 32-bit embedded address at its one
fixed position (bits 96 to 127, or 16 to 47 for 6to4) and it is checked against the IPv4
ranges in addition to the IPv6 check; the zone index is dropped before extraction.
`64:ff9b:1::/48` is a local-use NAT64 prefix (RFC 8215) whose operator may use any RFC 6052
layout of /48 or longer, so no one reading of its embedded address is authoritative; it is
an IPv6 range in the table and blocked whole, as are Teredo `2001::/32`, benchmarking
`2001:2::/48`, and discard-only `100::/64` (decision 59, which supersedes the per-layout
reading of decision 38).

**Host normalization.** Node's `URL` lowercases hostnames and canonicalizes IPv4 shorthand,
octal, hex, and decimal forms to dotted quads, and brackets IPv6 literals. The policy works on
`url.hostname` with brackets removed and one trailing dot removed. IP-literal detection uses
`node:net` `isIP`.

## fetcher.ts

```ts
type FetchedSource = {
  bytes: Uint8Array;
  finalUrl: URL;
  upstream: { etag?: string; lastModified?: string };
};

type FetcherDeps = {
  resolve?: (hostname: string) => Promise<string[]>;
  policy: PolicyConfig;
  limits: FetchLimits;
  serviceVersion: string;
};

function fetchSource(url: URL, deps: FetcherDeps, log: Logger): Promise<FetchedSource>;
// What app.ts hands to operations; declared beside its first importer, not in fetcher.ts.
type BoundFetch = (url: URL, log: Logger) => Promise<FetchedSource>;
```

`FetchLimits` is the slice of `Config` with the connect and total timeouts, the redirect
cap, and the byte cap. `resolve` defaults to `dns.promises.lookup(hostname, { all: true })`
mapped to address strings; tests inject a resolver that returns addresses in chosen ranges.
`log` is the per-request logger and receives the lines in "Logging" below; it is an argument
rather than a dependency so `deps` are bound once while each request's lines carry its
`requestId`, as `processImage` takes its logger (`design/caching.md`). `serviceVersion` is
the version in the `User-Agent` header (`image-service/<version>`); the composition root
supplies it because nothing under `source/` knows the package version (decision 39).

**Per hop:**

1. `checkUrl(url, previous)`; on denial throw `url_not_allowed` with the reason in detail.
2. If `url.hostname` is an IP literal, the address list is that literal; otherwise
   `resolve(hostname)`. An empty result is `upstream_error`.
3. `checkAddresses`; on denial throw `url_not_allowed`.
4. Request through an undici `Agent` whose `connect.lookup` returns exactly the validated
   address list for this hostname and fails for any other hostname. Node calls the lookup
   with `options.all` set (the default happy-eyeballs path), so it returns
   `[{ address, family }]` objects, not a string; a string there fails every connection.
   The hostname remains the TLS `servername` and the `Host` header, so certificate
   validation is against the name. `connectTimeout` is the connect budget. The request
   carries `maxRedirections: 0` (undici 8 rejects any other value on `request`; redirects
   are the fetcher's job), the headers in section 5, and one `AbortSignal.timeout(total)`
   created before hop 1 and shared by every hop. The deadline also bounds steps 2 and 4
   where the request's signal does not reach: resolution is raced against the signal
   (`dns.lookup` cannot be cancelled), and the signal destroys the hop's `Agent`, because
   undici does not abort a connection attempt in progress when the request's signal fires.
   The `Agent` is built per hop, because its lookup is bound to one hostname, and destroyed
   in a `finally` (not closed, which would wait on an unread body) so no socket outlives the
   hop.
5. If the status is 301, 302, 303, 307, or 308: read `Location`, resolve it against the
   current URL, discard the body, count the hop, and repeat from step 1 with `previous` set.
   A missing or unparseable `Location` is `upstream_error`. Exceeding `MAX_REDIRECTS` is
   `too_many_redirects`.
6. Any other non-2xx status is `upstream_error` with `upstreamStatus`.
7. A `Content-Encoding` other than `identity` is `upstream_error` with a detail naming it.
8. If `Content-Length` is present and above the cap, abort and throw `source_too_large`
   before reading. Otherwise read the body into chunks, counting; on exceeding the cap,
   abort and throw `source_too_large`.
9. Return the bytes, the final URL, and the upstream `ETag` and `Last-Modified` if present.
   No other response header is retained.

Timeouts: the connect timeout surfaces as `upstream_error`; the total deadline surfaces as
`upstream_timeout`. Connection refused, DNS failure, and TLS failure are `upstream_error`.
undici clears its connect timer the moment TCP connects, so a server that accepts and then
stays silent is caught by the total deadline, not the connect timeout. The connect timeout
therefore has no hermetic test: a loopback connect cannot be made to hang. For the same
reason the deadline destroying a hop's `Agent` during a connection attempt has no hermetic
test either. These gaps are recorded beside decision 33.

**Why undici `request` and not `fetch`.** `fetch` follows redirects and decompresses
automatically, both of which would bypass the per-hop policy and the byte cap. `request`
returns the raw response and respects `maxRedirections: 0`. The undici package is a runtime
dependency for this reason (decision 31).

## sniff.ts

```ts
import type { SourceType } from '@image-service/sdk';
function sniff(bytes: Uint8Array): SourceType | undefined;
```

`SourceType` is the SDK's union; it is the `/info` response's `format` value set, so the
SDK owns it.

Magic bytes, no dependency:

| Type | Signature |
|---|---|
| jpeg | `FF D8 FF` |
| png | `89 50 4E 47 0D 0A 1A 0A` |
| gif | `47 49 46 38` then `37 61` or `39 61` |
| webp | `52 49 46 46` at 0 and `57 45 42 50` at 8 |
| tiff | `49 49 2A 00` or `4D 4D 00 2A` |
| avif | `66 74 79 70` at 4 and brand `avif` or `avis` at 8 |

`undefined` means unsupported, including SVG, HTML, and truncated headers. The caller maps
`undefined` to `unsupported_source_type`. Dimension reading happens in the pipeline's
`inspect` (see `design/image-pipeline.md`), after sniffing.

## cache.ts

`SourceCache` wraps the `ByteLru` from `design/caching.md`, keyed by `url.href` as requested
(before redirects), holding `FetchedSource`, with `SOURCE_CACHE_TTL_SECONDS` and
`SOURCE_CACHE_MAX_BYTES`. A hit skips the fetcher entirely, including policy checks, which is
safe because the entry was admitted by the policy and cannot outlive the TTL.

## Logging

On denial: `info` with `hostname` and `reason`, plus `range` for an address denial, since
the problem's `detail` omits it. On fetch: `info` with `hostname`, final hostname if
different, `upstreamStatus`, `bytes`, `hops`, `durationMs`. Resolved addresses only at
`debug`, in a `source resolved` line with `hostname` and `addresses`, which is where an
operator finds the address behind an address denial. Never the full URL.

## Test table

Policy unit tests (`policy.test.ts`) are table-driven with the full `Decision` as the
expectation. Required rows, grouped:

- **Scheme and form:** `ftp://`, `file:///etc/passwd`, `data:`, `javascript:`; ports 8080,
  8443, 22, 0, and an explicit 80 and 443 that pass; `http://user:pw@example.com/`.
- **Names:** `localhost`, `LOCALHOST`, `localhost.`, `a.local`, `a.internal`, `a.localhost`;
  a `PUBLIC_HOSTS` entry in lower, upper, and trailing-dot forms; `localhost` listed in
  `ALLOWED_HOSTS` still denied (name rule applies regardless).
- **IPv4 literals:** one in each blocked range; `127.1`, `0177.0.0.1`, `0x7f.0.0.1`,
  `2130706433`, each asserting `hostname` canonicalized to `127.0.0.1` and denied.
- **IPv6 literals:** `[::1]`, `[::]`, `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`,
  `[::127.0.0.1]`, `[::ffff:0:127.0.0.1]`, `[64:ff9b::7f00:1]`, `[64:ff9b:1::7f00:1]`,
  `[2002:7f00:1::]`, `[fc00::1]`, `[fe80::1]`, `[fec0::1]`, `[ff02::1]`; and
  `[2606:4700::1111]` passes. An IPv4-translated address with a public embedded address
  passes. `64:ff9b:1::/48` and `2001::/32` are denied as whole ranges, each with an address
  that would be public by its embedded IPv4 reading, the top of the range, and a passing
  address just outside it; `2001:2::/48` and `100::/64` each with an address in the range,
  its top, and a passing address just outside it.
- **Addresses:** a public name resolving to one address in each blocked range; one public
  plus one private address denies; a zone-indexed address in an embedding prefix is judged by
  its embedded address; each denial's `detail` is the fixed category and its `range` the
  matching range; a resolution that is not an IP address denies; `ALLOWED_HOSTS` with
  port reaching `127.0.0.1:<port>` and denied at `127.0.0.1:<other>`; without a port,
  allowed on 443 and denied on a high port.
- **Downgrade:** `https` previous hop to `http` current denied; `http` to `https` allowed.

Fetcher integration tests (`apps/api/test/fetcher.test.ts`) run against the fake upstream
(`design/fake-upstream.md`) and an injected resolver:

- Each redirect status followed; relative `Location` resolved; chain of `MAX_REDIRECTS`
  succeeds and `MAX_REDIRECTS + 1` is `too_many_redirects`; a hop to a private address is
  `url_not_allowed`; a hop to a `PUBLIC_HOSTS` name is `url_not_allowed`; https to http is
  `url_not_allowed` (Deferred; see decision 40).
- `Content-Length` over the cap is `source_too_large` with zero body bytes read: the test
  requests `/huge?bytes=&ms=` with `ms` longer than `FETCH_TOTAL_TIMEOUT_MS`, so the fake
  sends the headers and holds the body, and asserts the error code and that the fake's
  `bytesSent` for that request is 0. A fetcher that waited for the body instead of checking
  `Content-Length` up front would get `upstream_timeout`. No `Content-Length` and an
  oversized body is `source_too_large` with the connection aborted; `Content-Encoding: gzip`
  is `upstream_error`.
- Upstream 404 and 500 are `upstream_error` with `upstreamStatus`; connection refused is
  `upstream_error`; a slow body past the total deadline is `upstream_timeout`; a server
  that accepts and sends no headers past the total deadline (`/slow-headers`) is
  `upstream_timeout`.
- A hostname whose injected resolution is private produces no TCP connection: no
  `net.client.socket` diagnostics-channel event is published during the fetch. The fake's
  connection log cannot show this, because the fake listens on an ephemeral port and a name
  that reaches the address rules is fetched on port 80 or 443. The same oracle shows that an
  empty resolution and a resolution outlasting the total budget connect nowhere.
- The loop-marker header is present on every hop (the fake echoes request headers).
- Upstream `ETag` and `Last-Modified` are returned; `Set-Cookie` and `X-Powered-By` from
  the fake are not present on the result.

Sniffer unit tests: every supported type from the generator; SVG, HTML, an empty buffer, a
three-byte buffer, and a PNG signature with the last byte altered all return `undefined`.
