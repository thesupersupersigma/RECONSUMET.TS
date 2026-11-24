# The fetch layer (`@reconsumet/core`)

**In plain English:** every outbound HTTP request RECONSUMΣT.TS makes (scrapers, the API, the video proxy) goes through
one function, `fetcher.request(url)`. It picks how to connect to each site: a normal Node request, or one that looks
exactly like Chrome down to the TLS handshake for sites that block scripts. It spaces requests out so we don't hammer
anyone, retries when a site hiccups, gives up cleanly on slow or huge responses, and tells you in plain terms when a page
is a Cloudflare/DDoS-Guard block instead of the real site. For URLs that come from outside (the proxy), it refuses to
connect anywhere private, so nobody can use us to reach tsss-server's internal network.

## Quick start

```ts
import { createFetcher, BlockedError } from '@reconsumet/core'

const fetcher = createFetcher({
  rules: [
    { match: 'flixcloud.cc', tier: 'impersonate', headers: { referer: 'https://example-source.to/' } },
    { match: 'example-source.to', rateLimit: { requests: 2, perMs: 1000 }, concurrency: 2 },
  ],
  escalate: { ttlMs: 6 * 3600_000 },
  cookies: true,
  onEvent: (e) => console.log(e.host, e.tier, e.status, e.class, `${e.ms}ms`),
})

const res = await fetcher.request('https://example-source.to/anime/123')
const html = await res.body.text()

try {
  await fetcher.request('https://some-cf-site.to/')
} catch (e) {
  if (e instanceof BlockedError) console.log('blocked:', e.class) // 'cf-challenge', 'cf-block', 'forbidden', …
}

await fetcher.close()
```

The proxy (0.4) streams instead of buffering, and marks URLs it got from playlists as untrusted:

```ts
const seg = await fetcher.request(segmentUrl, { untrusted: true, timeout: { totalMs: 120_000 } })
return new Response(seg.body.stream(), { status: seg.status })
```

## What `request()` returns

`{ status, headers, url, tier, profile, timing, body }`

| field | meaning |
|---|---|
| `status`, `headers` | of the final response (after redirects); `headers` is a standard `Headers` |
| `url` | final URL |
| `tier` | `plain` / `impersonate` that actually answered (after escalation) |
| `profile` | browser profile used (`null` for plain) |
| `timing` | `{ startedAt, headersMs, attempts }` |
| `body` | read once: `text()`, `json()`, `bytes()`, `stream()` (a web `ReadableStream`), or `cancel()` |

Always read or `cancel()` the body: that's when the request's concurrency slot is released and its event is emitted.
The size cap and total timeout apply while reading, streams included.

`request()` throws instead of returning when the response is a block page (see classifier) or something went wrong:

| error | when |
|---|---|
| `BlockedError` | response classified as `cf-challenge`, `cf-block`, `ddos-guard`, `forbidden`, or `rate-limited` (after retries). Has `.class`, `.status`, `.tier` |
| `FetchTimeoutError` | `.phase` is `connect` or `total` |
| `FetchNetworkError` | DNS failure, refused, reset, TLS error (retried first) |
| `SsrfError` | untrusted URL or one of its redirects points at a private/blocked address |
| `TooLargeError` | `Content-Length` or the streamed body is over `maxBytes` |
| `TooManyRedirectsError` | more than `maxRedirects` hops |
| `SolverNotImplementedError` | `tier: 'solver'` (stub until the solver milestone, brainstorm 2.6) |

All extend `FetchError` (has `.url`). A caller's own `AbortSignal` abort surfaces as its own reason.

## Tiers

| tier | what | when |
|---|---|---|
| `plain` | undici (Node's HTTP client), no impersonation | default; most sites and CDNs |
| `impersonate` | rustyTLS-js (our fork of wreq-js: BoringSSL, real Chrome JA3/JA4 + HTTP/2 fingerprint) | fingerprint-gated hosts (v1's `TLS_IMPERSONATE_HOSTS`) |
| `solver` | stub, throws `SolverNotImplementedError` | Cloudflare Managed Challenge, later (brainstorm 2.6) |

Tier for a request = per-call `tier` → a host remembered by escalation → the matching rule's `tier` → config `tier` → `plain`.

The impersonation library sits behind one internal interface (`src/fetch/transports/transport.ts`); only
`transports/impersonate.ts` imports it, so switching libraries touches that one file. Browser profiles are wreq-js names:
`chrome` (newest Chrome), `chrome_149`, `firefox`, `safari`, … (`getProfiles()` in wreq-js lists all 133).

**Escalation** (opt-in, `escalate: { ttlMs }`): when a `plain` request comes back `forbidden`, `cf-challenge`, `cf-block`
or `ddos-guard`, it is retried once through `impersonate`. If that works, the host is remembered for `ttlMs` and goes
straight to `impersonate` until then. A per-call `tier` disables escalation for that call.

## Config

```ts
createFetcher({
  tier?: 'plain' | 'impersonate' | 'solver',   // default 'plain'
  profile?: string,                            // default 'chrome'
  headers?: Record<string, string>,            // every request, lowest priority
  rules?: HostRule[],
  timeout?: { connectMs?: number, totalMs?: number },  // default 10 s / 30 s
  maxBytes?: number,                           // default 64 MiB
  maxRedirects?: number,                       // default 5
  retry?: { attempts?, baseMs?, maxMs?, methods? },     // default 2 retries, 500 ms base, 30 s max, GET+HEAD
  maxConcurrency?: number,                     // global, default 64
  escalate?: { ttlMs: number },                // off unless set
  cookies?: boolean,                           // default false
  onEvent?: (event: FetchEvent) => void,
  lookup?: (host, { all: true }) => Promise<{ address, family }[]>,  // DNS override (tests, split horizon)
})
```

**Host rules** — `match` is a host suffix (`example.com` matches `example.com` and every subdomain); the longest match
wins. Each rule may set `tier`, `profile`, `headers` (Referer, Origin, …), `rateLimit: { requests, perMs }`,
`concurrency` (default 8 per host when no rule sets it), and `timeout`. Rate limits space request *starts* evenly
(`requests` per `perMs` → one start every `perMs / requests` ms) rather than allowing bursts.

Header priority: config `headers` < rule `headers` < per-call `headers`. On a redirect to another origin,
`Authorization` and `Cookie` headers you passed are dropped.

**Per call** (`request(url, options)`): `method`, `headers`, `body`, `tier`, `profile`, `untrusted`, `timeout`,
`maxBytes`, `maxRedirects`, `retry` (or `false`), `signal`.

## Behaviour details

- **Retries:** network errors, timeouts, 5xx (that aren't block pages) and 429, for GET/HEAD by default. Backoff doubles
  from `baseMs` with "equal jitter" (between half and all of the step). `Retry-After` (seconds or a date) is honoured;
  if it asks for longer than `retry.maxMs`, the fetcher stops retrying.
- **Timeouts:** `connectMs` = TCP + TLS connect (plain tier; on impersonate via wreq's `connectTimeout`); `totalMs` = one
  attempt from the first byte sent to the last body byte read, redirects included.
- **Redirects** are followed manually (301/302/303/307/308). 303 → GET; 301/302 turn POST into GET; 307/308 keep the method.
- **SSRF guard** (`untrusted: true`): http/https only; refuses loopback, private (RFC 1918), CGNAT `100.64.0.0/10`
  (Tailscale, Alibaba metadata), link-local `169.254.0.0/16` (cloud metadata), multicast, reserved, IPv6 unique-local
  (incl. AWS `fd00:ec2::254`), link-local, multicast, and IPv6 forms that embed IPv4 (mapped, NAT64, 6to4, Teredo).
  If any DNS answer is blocked, the request is refused. The connection goes to the vetted address (plain: validating
  DNS lookup inside the socket connect; impersonate: a transport pinned with `resolve`), so DNS rebinding can't swap it.
  Every redirect hop is checked again.
- **Classifier** (`classify({ status, headers, body })`, exported for health checks): `ok`, `cf-challenge`
  (`cf-mitigated: challenge`, "Just a moment...", challenge scripts), `cf-block` (Cloudflare error 1006–1012, 1020,
  "Attention Required"), `ddos-guard`, `forbidden` (any other 401/403, including an origin's own 403 behind Cloudflare),
  `rate-limited` (429, Cloudflare 1015). `ok` only means "not a block"; a 404 is still `ok`.
- **Cookies** (`cookies: true`): one in-memory jar per fetcher (tough-cookie), shared by all tiers.
- **Events:** one `FetchEvent` per request when its body ends:
  `{ host, url, tier, profile, status, class, ms, bytes, retries, escalated, error? }`. Retries are counted in one event;
  an escalated request produces two events (the blocked plain one and the impersonate one, `escalated: true`).

## Known limits

- shortcut: untrusted impersonate requests get a fresh, unpooled transport each (pinned DNS can't be set per request on
  a pooled transport in wreq-js 3.2.0) — a full TLS handshake per request; cache pinned transports if the proxy needs it.
- shortcut: per-host gates live for the fetcher's lifetime; prune idle ones if a long-running proxy sees unbounded hosts.
- The impersonate tier's `profile` doesn't choose the OS; wreq's default OS for the profile is used.
- Body text is decoded as UTF-8.

## Tests

`pnpm test` — unit tests against local HTTP servers only (no internet): classifier, SSRF ranges + per-hop checks,
retries/backoff/Retry-After, rate limit, per-host and global concurrency, connect/total timeouts, size cap (header and
streaming), redirects, escalation (real wreq-js against a local server), streaming, cookies, events.
`pnpm test:live` — hits `https://tls.peet.ws/api/all` through each tier and checks the impersonate tier sends Chrome's
JA4 and HTTP/2 fingerprint.
