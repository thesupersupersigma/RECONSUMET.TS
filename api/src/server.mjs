// Self-hosted HTTP API over the anime aggregator. Returns raw stream sources for both
// sub and dub in a single /watch call, each pre-wrapped through a Referer-injecting HLS/
// subtitle /proxy so streams play in a browser. Internal name: "anime-api".
//
// Env:
//   PORT                   (default 3000; production runs on 4000 via env)
//   RATE_LIMIT_MAX         per-IP/min for cheap routes (/search), default 120; 0 disables that tier
//   RATE_LIMIT_SCRAPE      per-IP/min for live-scraping routes (/info,/episodes), default 60
//   RATE_LIMIT_WATCH       per-IP/min for /watch (extractor), default 30
//   RATE_LIMIT_PROXY       per-IP/min for /proxy, default 600. One video fires hundreds of segment
//                          requests, so this tier is deliberately high; 0 disables (exempts) it.
//   RATE_LIMIT_ROOT        per-IP/min for the / health/info route, default 140 (intentionally the
//                          most generous tier so real health checks never false-429); 0 exempts it.
//   RATE_LIMIT_WINDOW      rate-limit window in seconds (default 60)
//   RATE_LIMIT_TRUST_PROXY which proxies to trust when reading X-Forwarded-For for the client IP.
//                          'true' (default) trusts loopback+private ranges (our Traefik hop) — do
//                          NOT set to a value that trusts the whole chain; 'false' keys on the raw
//                          socket IP; a comma list of CIDRs/IPs trusts exactly those (e.g. an
//                          external SSR frontend). See RL_TRUST_PROXY for why 'true' != trust-all.
//   API_KEY                if set, /search /info /episodes /watch require it (x-api-key or Bearer). OFF by default.
//   DEBUG_INFO             if "1"/"true", the / route also exposes TLS-impersonation diagnostics (off by default)
//   HTTP_TIMEOUT_MS        (consumet lib) AniList/provider axios timeout (ms, default 20000)
//   PROXY_TIMEOUT_MS       upstream timeout for /proxy fetches — both plain fetch and curl-impersonate (ms, default 30000)
//   PUBLIC_URL             public base url used when building /proxy and /manga/image links. REQUIRED
//                          in any deployment: set it to the tunnel/public origin so rewritten playlists
//                          point back at us, not localhost. Validated at startup (http(s), no
//                          credentials/query/fragment) — a bad value exits instead of listening. When
//                          unset, links are derived from the request ONLY for a loopback Host arriving
//                          over a loopback socket (local dev); any other request answers 500. It is NOT
//                          derived from Host or X-Forwarded-Proto in general — both are client-supplied
//                          and were measured forgeable. See "THE PUBLIC BASE" in src/validators.mjs.
//   PUBLIC_URL_ALLOWED_ORIGINS
//                          optional comma-list of ADDITIONAL absolute origins this deployment answers on
//                          (apex + www, a tunnel alongside the real domain). A request whose Host matches
//                          one gets that configured origin in its links; anything else gets PUBLIC_URL.
//                          The Host only ever SELECTS from this list — it never contributes a byte.
//   CURL_IMPERSONATE_BIN   path to a curl-impersonate binary/wrapper (e.g. .../curl-impersonate). When set,
//                          fetches to TLS_IMPERSONATE_HOSTS go through it to clear Cloudflare JA3 gates.
//                          When empty, TLS impersonation silently no-ops (plain fetch → those hosts 403).
//   CURL_IMPERSONATE_ARGS  extra args for the binary (e.g. "--impersonate chrome124" for the single-binary
//                          builds; leave empty when using the curl_chromeNNN wrapper scripts).
//   TLS_IMPERSONATE_HOSTS  comma-list of host suffixes routed through curl-impersonate (default flixcloud.cc,overcdn.site)
//   RATE_LIMIT_IMAGE       per-IP/min for /manga/image, default 300. Its OWN tier so a manga reader
//                          and a video stream cannot evict each other; 0 disables (exempts) it.
//   (manga-only knobs — MANGA_TIMEOUT_MS, MANGA_READ_TIMEOUT_MS, MANGA_IMAGE_TIMEOUT_MS,
//    MANGA_IMAGE_MAX_BYTES, MANGA_DIRECT_IMAGE_HOSTS — are read by and documented in
//    api/src/manga-routes.mjs.)
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { assertUrlSafe, followSafeRedirects, SsrfError } from './ssrf-guard.mjs';
import { isSingle, isNumericId, isRefererUrl, originHeaderValue, isHeaderToken, resolvePublicBaseEnv } from './validators.mjs';
import mangaRoutes, { createMangaAggregator } from './manga-routes.mjs';
import pkg from '../../consumet/dist/index.js';

const { AnimeAggregator, MangaAggregator } = pkg;

const PORT = Number(process.env.PORT) || 3000; // explicit default 3000; production sets PORT=4000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 30000;

// --- TLS-impersonation (curl-impersonate) config ---
// When CURL_IMPERSONATE_BIN is unset, needsImpersonation() returns false and every /proxy
// fetch falls back to plain node fetch — which the JA3-gated CDNs (flixcloud.cc, overcdn.site)
// answer with a 403. A working binary path in production is required, not just this code.
const CURL_BIN = process.env.CURL_IMPERSONATE_BIN || '';
const CURL_ARGS = (process.env.CURL_IMPERSONATE_ARGS || '').split(' ').filter(Boolean);
// vid-cdn.xyz / xin-cdn.xyz are AniZone's own CDN — TLS-fingerprint (JA3/JA4) gated the
// same way as flixcloud/overcdn (plain handshakes are reset), so its manifests/segments/keys
// must go through curl-impersonate too.
// anidb.app is Cloudflare TLS-gated: the AniDB *provider* fetches its metadata (search/
// episodes/languages/embed) through this same CURL_IMPERSONATE_BIN — it's listed here as the
// canonical registry of hosts needing impersonation. NOTE: anidb.app metadata is resolved
// provider-side (not via /proxy); only its un-gated hls.anidb.app CDN traffic actually flows
// through /proxy, and that suffix-matches this entry so segments also get impersonated —
// harmless (impersonation succeeds on the CDN too), just not strictly required there.
// uwucdn.top is AnimePahe's kwik video CDN — it answers ONLY over HTTP/2 (403s HTTP/1.1), which
// Node's plain `fetch` can't do, so its master/key/segments must go through curl-impersonate (which
// speaks HTTP/2). Suffix-matches the rotating `vault-NN.uwucdn.top` segment hosts.
const TLS_HOSTS = (process.env.TLS_IMPERSONATE_HOSTS || 'flixcloud.cc,overcdn.site,vid-cdn.xyz,xin-cdn.xyz,anidb.app,uwucdn.top')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// --- rate limiting (tiered, in-memory) + optional API key ---
const RL_WINDOW_MS = (Number(process.env.RATE_LIMIT_WINDOW) || 60) * 1000;
// Which upstream proxies to trust when resolving the client IP from X-Forwarded-For.
// SECURITY: must NOT be `true`. Fastify's `trustProxy: true` trusts the ENTIRE client-supplied
// XFF chain, so req.ip becomes the left-most (caller-controlled) entry — any external client can
// then forge/rotate their IP: rotate a fake IP per request to get a fresh rate-limit bucket every
// time, or send a private IP to hit the internal-worker exemption below. Both fully defeat the
// limiter (verified: rotating XFF let a burst sail straight through to AniList unthrottled).
// We front the API with exactly one proxy (Traefik) on the private Docker network, so we trust
// only loopback + private ranges. proxy-addr then walks [socket, …XFF] and returns the first
// address OUTSIDE those ranges — i.e. the real public IP Traefik observed — ignoring anything the
// caller injected to its left. Value forms (RATE_LIMIT_TRUST_PROXY):
//   'true' (default) → trust loopback + private ranges (our proxy) — the secure default.
//   'false'          → trust nothing; key on the raw socket IP (only correct with NO proxy).
//   comma list       → explicit CIDRs/IPs (e.g. add a known external SSR frontend's IP).
const RL_TRUST_RAW = (process.env.RATE_LIMIT_TRUST_PROXY ?? 'true').trim();
const RL_TRUST_PROXY = /^false$/i.test(RL_TRUST_RAW)
  ? false
  : /^true$/i.test(RL_TRUST_RAW)
    ? ['loopback', 'linklocal', 'uniquelocal']
    : RL_TRUST_RAW.split(',').map(s => s.trim()).filter(Boolean);
const RL_TIERS = {
  default: Number(process.env.RATE_LIMIT_MAX ?? 120),
  scrape: Number(process.env.RATE_LIMIT_SCRAPE ?? 60),
  watch: Number(process.env.RATE_LIMIT_WATCH ?? 30),
  proxy: Number(process.env.RATE_LIMIT_PROXY ?? 600), // hundreds of segments/stream — high or 0 (exempt)
  // `/` health/info: deliberately the most generous tier (> every other route) so a legitimate
  // Coolify/monitoring health check never risks a false 429, while still capping the sustained,
  // real CPU load an unthrottled root route otherwise lets anyone generate. 0 disables (exempts).
  root: Number(process.env.RATE_LIMIT_ROOT ?? 140),
  // /manga/image: a reader prefetching chapters fires 20-60 image requests per chapter — bursty,
  // but nothing like a video's segment storm. Its OWN bucket on purpose: sharing 'proxy' would let
  // manga reads and video playback evict each other from the same per-IP limit. 0 disables (exempts).
  image: Number(process.env.RATE_LIMIT_IMAGE ?? 300),
};
const API_KEY = process.env.API_KEY || ''; // OFF by default — set to require auth on data routes
const DEBUG_INFO = /^(1|true)$/i.test(process.env.DEBUG_INFO || '');

// --- the public origin used in every link we mint (see "THE PUBLIC BASE" in ./validators.mjs) ---
// Parsed ONCE here and checked before anything listens, so a typo'd PUBLIC_URL is a one-line
// startup failure rather than a fleet of subtly wrong links. manga-routes.mjs reads the same env
// through the same function, so /proxy and /manga/image can never disagree again.
const PUBLIC_BASE = resolvePublicBaseEnv();
if (PUBLIC_BASE.error) {
  console.error(`anime-api: refusing to start — ${PUBLIC_BASE.error.message}`);
  process.exit(1);
}

// trustProxy scoped to our own proxy hop (see RL_TRUST_PROXY above): the socket IP is Traefik's,
// so we resolve the real client IP from X-Forwarded-For for per-IP keying — but only trusting
// our proxy's ranges, so a caller can't forge req.ip by injecting XFF entries.
const app = Fastify({ logger: true, trustProxy: RL_TRUST_PROXY });
// CORS '*' is INTENTIONAL: a public, read-only metadata/stream API called from arbitrary
// frontends; no cookies/credentials are used. Tighten only if you add origin-dependent auth.
await app.register(cors, { origin: '*' });

const agg = new AnimeAggregator();
// The manga surface's aggregator. Constructed HERE, next to the anime one, so this file keeps the
// single import of the consumet bundle and api/src/manga-routes.mjs can stay free of it (a manga
// provider that ships broken must not be able to break the routes module's import graph).
//
// The one piece of wiring it needs is the `imageProxy` seam — the function that turns each page's
// raw upstream URL into a /manga/image link on THIS deployment's origin, with the per-page Referer
// baked in. That is installed by createMangaAggregator, which lives in manga-routes.mjs next to the
// route those links point at (see the AsyncLocalStorage note there for why the origin cannot be a
// plain constructor argument). The class is passed in so the dist import stays in this file alone.
const mangaAgg = createMangaAggregator(MangaAggregator);

// in-memory fixed-window buckets keyed by tier+IP; private/loopback IPs bypass (internal workers).
const rlBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rlBuckets) if (b.resetAt <= now) rlBuckets.delete(k);
}, RL_WINDOW_MS).unref();

const clientIp = req => (req.ip || '').replace(/^::ffff:/, '');
const isPrivateIp = ip =>
  !ip ||
  ip === '127.0.0.1' ||
  ip === '::1' ||
  ip.startsWith('10.') ||
  ip.startsWith('192.168.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

const rateLimit = tier => async (req, reply) => {
  const limit = RL_TIERS[tier] ?? RL_TIERS.default;
  if (!limit || limit <= 0) return; // tier disabled
  const ip = clientIp(req);
  if (isPrivateIp(ip)) return; // loopback / internal sync bypass
  const now = Date.now();
  const key = `${tier}:${ip}`;
  let b = rlBuckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RL_WINDOW_MS };
    rlBuckets.set(key, b);
  }
  if (++b.count > limit) {
    const retryAfter = Math.ceil((b.resetAt - now) / 1000);
    reply.header('Retry-After', String(retryAfter));
    return reply.code(429).send({ error: 'rate limit exceeded', tier, retryAfter });
  }
};

// optional API-key gate (off unless API_KEY is set). Applied to data routes, NOT / or /proxy
// (proxy URLs are embedded in rewritten playlists the video player fetches — can't carry a header).
const requireApiKey = async (req, reply) => {
  if (!API_KEY) return; // disabled by default
  const provided = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== API_KEY) return reply.code(401).send({ error: 'invalid or missing API key' });
};

// preHandler stack for a data route at the given rate-limit tier
const apiGuard = tier => [requireApiKey, rateLimit(tier)];

// validation helpers
// `isSingle`, `isNumericId` and the outbound-header validators (`isRefererUrl`,
// `originHeaderValue`, `isHeaderToken`) are imported from ./validators.mjs, shared with
// api/src/manga-routes.mjs. They used to be copy-pasted into both files behind a "change one,
// change the other" comment; that is how /proxy ended up without the scheme check /manga/image
// has. See that module's header for the measured threat model behind the header validators.
/** Escape a user-supplied string for literal use inside a RegExp source. */
const reEscape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- proxy link building + HLS rewrite ----

// The origin every generated link is prefixed with. NOT derived from `req.headers.host` or
// `req.protocol` — both are client-supplied, and both were measured to be forgeable here (a Host of
// `evil.attacker.example` came back inside pages[].img and inside every URI of a rewritten
// playlist; `X-Forwarded-Proto: gopher` came back as the scheme, because Fastify's trustProxy
// forwards that header unvalidated). See "THE PUBLIC BASE" in ./validators.mjs for the measurements,
// the rejected alternatives, and why the loopback dev fallback cannot fire in production.
// Shared with manga-routes.mjs's /manga/image links, which is the whole reason it lives there: the
// two copies of this helper were byte-identical and only one of them would have been fixed.
const proxyBase = PUBLIC_BASE.resolve;

/**
 * Resolve the public base, or answer 500 and return null. LOUD ON PURPOSE: the failure being fixed
 * is a misconfigured server quietly emitting attacker-controlled links, so the replacement must not
 * be a quietly-wrong-but-safe link (a root-relative `sources[].url` would silently break the
 * cross-origin frontend). The message names the variable to set; `err` puts it in the log too.
 */
const baseOr500 = (req, reply) => {
  try {
    return proxyBase(req);
  } catch (e) {
    req.log.error({ err: e, host: req.headers.host }, 'cannot resolve the public base for this request');
    reply.code(500).send({ error: e.message });
    return null;
  }
};
const wrapUrl = (base, url, ref, pk, km, org, aud) =>
  `${base}/proxy?url=${encodeURIComponent(url)}` +
  `${ref ? `&ref=${encodeURIComponent(ref)}` : ''}` +
  `${pk ? `&pk=${encodeURIComponent(pk)}` : ''}` +
  `${km ? `&km=${encodeURIComponent(km)}` : ''}` +
  `${org ? `&org=${encodeURIComponent(org)}` : ''}` +
  `${aud ? `&aud=${encodeURIComponent(aud)}` : ''}`;

// rewrite an HLS playlist so every segment / sub-playlist / key goes back through the
// proxy. `pk` (playlist XOR key), `km` (UniqueStream key.bin media_id), `org` (segment-CDN
// Origin) and `aud` (KickAssAnime default-audio language) are propagated so child playlists
// inherit de-obfuscation, the key transform, the Origin header and the audio-default rewrite.
const rewriteM3U8 = (text, baseUrl, ref, base, pk, km, org, aud) => {
  const wrap = u => wrapUrl(base, new URL(u, baseUrl).href, ref, pk, km, org, aud);
  return text
    .split('\n')
    .map(line => {
      const l = line.trim();
      if (!l) return line;
      if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${wrap(u)}"`);
      return wrap(l);
    })
    .join('\n');
};

// KickAssAnime serves one HLS master with both a Japanese (DEFAULT=YES) and an English audio
// group; for the dub we must make the requested audio the default so a player picks it. Rewrite
// each `#EXT-X-MEDIA:TYPE=AUDIO` line: DEFAULT/AUTOSELECT=YES on the matching LANGUAGE, NO on the
// rest. No-op on non-master playlists (no audio media lines) and when `aud` is unset.
const setDefaultAudio = (text, aud) => {
  if (!aud) return text;
  return text
    .split('\n')
    .map(line => {
      if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=AUDIO/.test(line)) return line;
      // `aud` is a raw query param, so it is regex-ESCAPED before interpolation. Unescaped, a
      // crafted ?aud= is a regex-injection primitive on an unauthenticated route: `?aud=(` makes
      // `new RegExp` throw (500), and `?aud=(x+x+)+y` builds a catastrophically-backtracking
      // pattern that is re-run for every audio line of the playlist. Escaping is behaviour-neutral
      // for the real values (ISO-639 codes like `eng`/`ja-JP` contain no metacharacters).
      const target = new RegExp(`LANGUAGE="${reEscape(aud)}"`, 'i').test(line);
      const stripped = line.replace(/,DEFAULT=(?:YES|NO)/gi, '').replace(/,AUTOSELECT=(?:YES|NO)/gi, '');
      return stripped + (target ? ',DEFAULT=YES,AUTOSELECT=YES' : ',DEFAULT=NO,AUTOSELECT=NO');
    })
    .join('\n');
};

// FlixCloud (and similar) XOR-obfuscate the playlist body with a per-video base64 key.
// If the decoded body isn't already an #EXTM3U playlist, undo the repeating-key XOR.
const deobfuscatePlaylist = (text, pkB64) => {
  if (!pkB64 || text.startsWith('#EXTM3U')) return text;
  try {
    const key = Buffer.from(pkB64, 'base64');
    const cipher = Buffer.from(text.trim(), 'base64');
    const out = Buffer.alloc(cipher.length);
    for (let i = 0; i < cipher.length; i++) out[i] = cipher[i] ^ key[i % key.length];
    const plain = out.toString('utf8');
    return plain.startsWith('#EXTM3U') ? plain : text;
  } catch {
    return text;
  }
};

// UniqueStream serves its AES-128 `key.bin` as base64 *ciphertext*, not a raw 16-byte key.
// Reproduce the player's transform: base64-decode the body, then AES-128-CBC-decrypt it with
// key = sha256("key"+media_id)[:16] and iv = sha256("iv"+media_id)[:16] → the real content key.
// (The key.bin fetch must also carry `x-am-media-id: media_id` — the CDN encrypts the body
// against that header, so a mismatched/absent id yields an undecryptable body.)
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest();
const deriveUniqueStreamKey = (bodyText, mediaId) => {
  const ciphertext = Buffer.from(bodyText.trim(), 'base64');
  const key = sha256('key' + mediaId).subarray(0, 16);
  const iv = sha256('iv' + mediaId).subarray(0, 16);
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv); // PKCS7 padding on by default
  return Buffer.concat([d.update(ciphertext), d.final()]);
};

// ---- upstream fetch: plain fetch, or curl-impersonate for JA3-gated CDNs ----

const needsImpersonation = target => {
  if (!CURL_BIN) return false;
  try {
    const host = new URL(target).host;
    return TLS_HOSTS.some(d => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
};

// parse curl's `-D` header dump into { status, headers } (lowercased keys); tolerant of HTTP/2
const parseHeaderDump = raw => {
  const blocks = raw.split(/\r?\n\r?\n/).filter(b => /^HTTP\//.test(b.trim()));
  const block = blocks[blocks.length - 1] || raw;
  const lines = block.split(/\r?\n/).filter(Boolean);
  const status = parseInt((lines[0]?.match(/^HTTP\/[\d.]+\s+(\d+)/) || [])[1] || '0', 10);
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx < 0) continue;
    headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
  }
  return { status, headers };
};

const streamToString = async stream => {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

// run curl-impersonate, resolving as soon as the response header block is parsed so the
// body (fd 1) can stream. Response headers are dumped to fd 3 (parent reads child.stdio[3]).
const impersonatedFetch = (target, { referer, range, extraHeaders }) =>
  new Promise((resolve, reject) => {
    // The CDN gate needs a *fetch*-style request (like hls.js), not curl-impersonate's
    // default *navigation* headers — Referer alone is rejected. We override the
    // sec-fetch/accept/origin set; the UA + sec-ch-ua + TLS fingerprint come from the
    // impersonation profile. (Use the single-binary `--impersonate` build so these
    // -H values cleanly override the profile defaults instead of duplicating them.)
    //
    // WHERE THESE VALUES COME FROM (audited: every header below that is not a literal):
    //   referer / extraHeaders  — /proxy's `ref`, `km` and `org`, each shape-validated at the route
    //                             boundary against ./validators.mjs before it gets here.
    //   origin (derived)        — `new URL(referer || target).origin`. Both inputs are validated
    //                             http(s) URLs by the time they arrive, so this is a real origin;
    //                             an unvalidated `ref` used to be able to make it the literal
    //                             string "null" (e.g. ref=javascript:alert(1)).
    //   range                   — the CLIENT's own Range header, which Node's HTTP parser already
    //                             refuses to deliver with a control character in it, so it needs
    //                             no second check. (Duplicate Range headers are joined by Node
    //                             with ", " into one string, never an array.)
    let origin;
    try {
      origin = new URL(referer || target).origin;
    } catch {}
    const hdrs = {
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity', // raw passthrough → segment content-length stays valid
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      ...(origin ? { Origin: origin } : {}),
      ...(referer ? { Referer: referer } : {}),
      ...(range ? { Range: range } : {}),
      ...(extraHeaders || {}),
    };
    const args = [...CURL_ARGS, '-sS', '-N', '--max-time', String(Math.ceil(PROXY_TIMEOUT_MS / 1000)), '-D', '/dev/fd/3'];
    for (const [k, v] of Object.entries(hdrs)) args.push('-H', `${k}: ${v}`);
    args.push(target);

    const child = spawn(CURL_BIN, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let headerBuf = '';
    let errBuf = '';
    let settled = false;

    child.stdio[3].on('data', d => {
      headerBuf += d.toString();
      if (!settled && /\r?\n\r?\n/.test(headerBuf)) {
        settled = true;
        const { status, headers } = parseHeaderDump(headerBuf);
        resolve({ status, headers, body: child.stdout, child });
      }
    });
    child.stderr.on('data', d => (errBuf += d.toString()));
    child.on('error', err => !settled && (reject(err), (settled = true)));
    child.on('close', code => {
      if (!settled) {
        settled = true;
        reject(new Error(`curl-impersonate exited ${code}: ${errBuf.slice(0, 200) || 'no headers'}`));
      }
    });
  });

// unified upstream: returns { status, getHeader, text, nodeStream, cleanup }
const proxiedUpstream = async (target, { referer, range, extraHeaders }) => {
  if (needsImpersonation(target)) {
    const r = await impersonatedFetch(target, { referer, range, extraHeaders });
    return {
      status: r.status,
      getHeader: name => r.headers[name.toLowerCase()],
      text: () => streamToString(r.body),
      nodeStream: r.body,
      cleanup: () => {
        try {
          r.child.kill('SIGKILL');
        } catch {}
      },
    };
  }
  const headers = { 'User-Agent': UA };
  if (referer) headers.Referer = referer;
  if (range) headers.Range = range;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  // Manual redirect-following with per-hop SSRF re-validation (the redirect is part of the exploit
  // path — a public URL that 302s to a private/metadata address must be caught here, not followed).
  const r = await followSafeRedirects(target, { headers, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
  return {
    status: r.status,
    getHeader: name => r.headers.get(name),
    text: () => r.text(),
    // lazy: Readable.fromWeb() locks the body, so only convert if the segment branch
    // actually reads it — the playlist branch uses text() instead and must not lock it first.
    get nodeStream() {
      return r.body ? Readable.fromWeb(r.body) : null;
    },
    cleanup: null,
  };
};

// ---- meta / scraping routes ----

// Health/info. Rate-limited on its own generous 'root' tier via the same hardened IP
// resolution as every other route (no separate, spoofable IP path); not API-key gated.
app.get('/', { preHandler: rateLimit('root') }, async () => {
  const base = {
    name: 'anime-api',
    status: 'ok',
    providers: agg.providers.map(p => p.name),
    // A DIFFERENT provider set, not a subset: the manga registry shares no provider with the anime
    // one. Listed because it is also the set of valid ?provider= values on /manga/chapters and
    // /manga/read, both of which 400 with this same list on a typo.
    mangaProviders: mangaAgg.providerNames,
    routes: {
      search: 'GET /search?q=<query>&page=1',
      info: 'GET /info/:anilistId   (provider mappings = available sources)',
      episodes: 'GET /episodes/:anilistId?provider=Gogoanime',
      watch: 'GET /watch?provider=Gogoanime&episodeId=<id>   (returns proxied sources for sub and dub)',
      proxy: 'GET /proxy?url=<encoded>&ref=<encoded referer>&pk=<encoded>   (HLS/segment/subtitle proxy)',
      // Manga surface. All five routes are live against MangaAggregator; /manga/image serves the
      // bytes that /manga/read's pages[].img links point at.
      manga: {
        search: 'GET /manga/search?q=<query>&page=1',
        info: 'GET /manga/info/:anilistId   (AniList MANGA id space — NOT the anime id)',
        chapters: 'GET /manga/chapters/:anilistId?provider=<name>&lang=en',
        read: 'GET /manga/read?provider=<name>&chapterId=<id>&lang=en',
        image: 'GET /manga/image?url=<encoded>&ref=<encoded referer>   (Referer-injecting, image-only page proxy)',
      },
    },
  };
  // VM internals (TLS-impersonation host list) only when DEBUG_INFO is set
  if (!DEBUG_INFO) return base;
  return {
    ...base,
    tlsImpersonation: CURL_BIN ? { enabled: true, hosts: TLS_HOSTS } : { enabled: false },
  };
});

app.get('/search', { preHandler: apiGuard('default') }, async (req, reply) => {
  // Repeated params (see isSingle): both reads here already fail CLOSED, so they need no extra
  // check. `?q=a&q=b` is an array → the typeof test below fails → q = '' → 400 (verified, not
  // assumed). `?page=1&page=2` is an array → Number([...]) is NaN → `|| 1` → page 1, the default.
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) return reply.code(400).send({ error: "missing or empty 'q' query param" });
  const page = Number(req.query.page) || 1;
  if (page < 1) return reply.code(400).send({ error: "'page' must be >= 1" });
  try {
    return { results: await agg.search(q, page) };
  } catch (e) {
    return reply.code(502).send({ error: `search upstream failed: ${e.message}` });
  }
});

app.get('/info/:anilistId', { preHandler: apiGuard('scrape') }, async (req, reply) => {
  if (!isNumericId(req.params.anilistId))
    return reply.code(400).send({ error: 'anilistId must be numeric' });
  try {
    return { id: req.params.anilistId, mappings: await agg.getMappings(req.params.anilistId) };
  } catch (e) {
    return reply.code(502).send({ error: `mapping upstream failed: ${e.message}` });
  }
});

app.get('/episodes/:anilistId', { preHandler: apiGuard('scrape') }, async (req, reply) => {
  if (!isNumericId(req.params.anilistId))
    return reply.code(400).send({ error: 'anilistId must be numeric' });
  // A repeated ?provider= is an array; the aggregator calls providerName.toLowerCase() on it and
  // dies with a TypeError that surfaced as a 502 leaking "name.toLowerCase is not a function".
  // That is a 400-class client error, so it is answered as one, before the aggregator is touched.
  if (!isSingle(req.query.provider))
    return reply.code(400).send({ error: "'provider' must be given at most once" });
  try {
    return await agg.getEpisodes(req.params.anilistId, req.query.provider);
  } catch (e) {
    return reply.code(502).send({ error: `episodes upstream failed: ${e.message}` });
  }
});

// All servers for both sub and dub, fetched concurrently and returned together.
//
// RESPONSE SHAPE CHANGE (paired site-side change is being handled separately this session):
// `sub` and `dub` are now ARRAYS of per-server results (previously a single object each),
// ordered with the provider's default/auto-play server FIRST — a client that just takes
// index [0] gets the previous default behavior, while the rest are selectable alternates.
// Each array element has the same per-source shape as before, plus `serverName`:
//   { serverName?, sources[] (wrapped url + rawUrl), subtitles[] (wrapped), headers?, intro?, outro?, pk? }
// A type is null if it was rejected or yielded zero playable servers; 502 only if both are null.
// Providers without multi-server support come back as a 1-element array (getSourcesAll fallback).
app.get('/watch', { preHandler: apiGuard('watch') }, async (req, reply) => {
  const { provider, episodeId } = req.query;
  if (!provider || !episodeId) {
    return reply.code(400).send({ error: "missing 'provider' and/or 'episodeId' query params" });
  }
  // Repeated-param guard, and it is load-bearing for the SSRF check below, not cosmetic:
  // `?episodeId=x&episodeId=y` arrives as an ARRAY, an array is not `typeof 'string'`, so the
  // assertUrlSafe() call below was skipped ENTIRELY and the value flowed on to the provider —
  // while `?episodeId=http://169.254.169.254/x&episodeId=` stringifies to the perfectly valid URL
  // "http://169.254.169.254/x," for anything downstream that interpolates rather than calling
  // .startsWith(). None of the 13 registered providers stringify today (they all TypeError on
  // .startsWith/.split first — measured, every one 502s without opening a socket), so this was a
  // latent hole rather than a live one; it is closed at the boundary so it cannot be re-opened by
  // a provider edit. `provider` is checked for the same reason: an array reaches the aggregator,
  // which TypeErrors on providerName.toLowerCase() and answers a misleading 502.
  if (!isSingle(provider) || !isSingle(episodeId)) {
    return reply.code(400).send({ error: "'provider' and 'episodeId' must each be given at most once" });
  }
  // M2 SSRF guard: several providers (gogoanime, anizone, anineko, animenosub, senshi) treat an
  // episodeId that starts with "http" as a full URL and fetch it directly. That makes episodeId a
  // second SSRF vector — ?episodeId=http://169.254.169.254/... — so it goes through the SAME guard
  // as /proxy (H1). Non-URL ids (the normal case) are untouched. Blind (the body isn't returned),
  // but it still enables internal host/port probing from the server, so we close it at this boundary.
  if (typeof episodeId === 'string' && episodeId.startsWith('http')) {
    try {
      await assertUrlSafe(episodeId);
    } catch (e) {
      if (e instanceof SsrfError) return reply.code(400).send({ error: `'episodeId' rejected: ${e.message}` });
      return reply.code(400).send({ error: "invalid 'episodeId' query param" });
    }
  }

  const base = baseOr500(req, reply);
  if (base === null) return reply;
  // shape ONE server's ISource into a response object, or null if it has no sources. Each
  // source/subtitle url is wrapped through /proxy (Referer-injecting + TLS-impersonating),
  // with the original kept as rawUrl. m3u8 sources thread the playlist-deobfuscation key
  // (src.pk) so XOR-obfuscated FlixCloud/ReAnime playlists decode; subtitles never need it.
  const shapeOne = src => {
    if (!src || !(src.sources?.length)) return null;
    const ref = src.headers?.Referer;
    const org = src.headers?.Origin;
    const wrap = (u, pk, km, aud) => (u ? wrapUrl(base, u, ref, pk, km, org, aud) : u);
    const out = {
      sources: src.sources.map(s => ({ ...s, url: wrap(s.url, src.pk, src.keyMediaId, src.audioDefault), rawUrl: s.url })),
      subtitles: (src.subtitles ?? []).map(s => ({ ...s, url: wrap(s.url), rawUrl: s.url })),
    };
    if (src.serverName != null) out.serverName = src.serverName;
    if (src.headers != null) out.headers = src.headers;
    if (src.intro != null) out.intro = src.intro;
    if (src.outro != null) out.outro = src.outro;
    if (src.pk != null) out.pk = src.pk;
    if (src.keyMediaId != null) out.keyMediaId = src.keyMediaId;
    if (src.audioDefault != null) out.audioDefault = src.audioDefault;
    return out;
  };
  // shape a getSourcesAll() list into an array of server results (default first), or null if none.
  const shapeAll = list => {
    const arr = (Array.isArray(list) ? list : []).map(shapeOne).filter(Boolean);
    return arr.length ? arr : null;
  };

  const [subRes, dubRes] = await Promise.allSettled([
    agg.getSourcesAll(provider, episodeId, 'sub'),
    agg.getSourcesAll(provider, episodeId, 'dub'),
  ]);

  if (subRes.status === 'rejected') app.log.warn({ provider: req.query.provider, err: subRes.reason?.message }, 'sub getSourcesAll failed');
  if (dubRes.status === 'rejected') app.log.warn({ provider: req.query.provider, err: dubRes.reason?.message }, 'dub getSourcesAll failed');

  const sub = subRes.status === 'fulfilled' ? shapeAll(subRes.value) : null;
  const dub = dubRes.status === 'fulfilled' ? shapeAll(dubRes.value) : null;

  if (!sub && !dub) {
    return reply.code(502).send({ error: 'no sources found for sub or dub' });
  }
  return { sub, dub };
});

// ---- Referer-injecting HLS / segment / subtitle proxy ----
// No API-key gate: proxy URLs are embedded in rewritten playlists the video player fetches
// directly, so they can't carry an x-api-key header. Rate-limited on its own high 'proxy' tier.
app.get('/proxy', { preHandler: rateLimit('proxy') }, async (req, reply) => {
  const target = req.query.url;
  const rawRef = req.query.ref;
  const pk = req.query.pk;
  const rawKm = req.query.km;
  const rawOrg = req.query.org; // segment-CDN Origin (KickAssAnime segments 403 without it)
  const aud = req.query.aud; // default-audio language for the HLS master (KickAssAnime dub)
  if (!target) return reply.code(400).send({ error: "missing 'url' query param" });
  // EVERY param on this route is checked for multiplicity, not just the fetched one — a repeated
  // param is an array and each of these is consumed as a string further down:
  //   url → assertUrlSafe/new URL (an array stringifies identically in the guard and in the fetch,
  //         so it is not a bypass — measured: ?url=<internal>&url= is still 400 with no socket —
  //         but it is rejected here so the route never depends on that coincidence);
  //   ref, org → outbound Referer/Origin HEADERS, where an array becomes "a,b";
  //   km → the x-am-media-id header AND the AES key derivation;
  //   pk → Buffer.from(v,'base64'), which for an ARRAY takes the array-of-octets overload and
  //        silently yields a zero key instead of decoding anything;
  //   aud → interpolated into a RegExp.
  // None of those want an array, so none of them get one.
  if (![target, rawRef, pk, rawKm, rawOrg, aud].every(isSingle))
    return reply.code(400).send({ error: "'url', 'ref', 'pk', 'km', 'org' and 'aud' must each be given at most once" });
  // ref/org/km land in OUTBOUND REQUEST HEADERS, so each is validated by SHAPE here — rejected,
  // not sanitised (see api/src/validators.mjs, which owns all three checks and the measurements
  // behind them). Empty string is treated as absent, matching /manga/image and matching wrapUrl,
  // which omits an empty param rather than emitting `&ref=`.
  //
  // WHAT THIS IS AND IS NOT. It is NOT a header-injection fix: neither transport can be made to
  // emit a second header. undici throws on a CR/LF-bearing value (the plain-fetch path already
  // fails closed with a 502), and the curl-impersonate path passes each header as one element of a
  // spawn() argv array with no shell, so `-H` / `${k}: ${v}` cannot be split — measured on the real
  // path with test/fixtures/fake-curl.mjs, which dumps its own argv. A colon inside a header value
  // is legal, so `ref=https://a.example/X-Injected: pwned` was always ONE odd Referer, never two
  // headers. What it IS: parity with /manga/image, which has scheme-checked its `ref` all along
  // while /proxy — older and far more used — did not; and it stops `ref=javascript:alert(1)` both
  // from becoming a Referer and from becoming `Origin: null` upstream (impersonatedFetch derives
  // the Origin from the referer when the caller supplies no `org`).
  if (rawRef && !isRefererUrl(rawRef))
    return reply.code(400).send({ error: "'ref' must be an http(s) url" });
  if (rawKm && !isHeaderToken(rawKm))
    return reply.code(400).send({ error: "'km' must be a printable token with no spaces (<= 256 chars)" });
  // An Origin is a SERIALIZED ORIGIN, not a URL — scheme + host + optional port, no path. Stricter
  // than the referer check on purpose, and normalised (a trailing slash is dropped) rather than
  // relayed verbatim.
  const org = rawOrg ? originHeaderValue(rawOrg) : undefined;
  if (rawOrg && !org)
    return reply.code(400).send({ error: "'org' must be a serialized origin (scheme://host[:port], no path)" });
  const ref = rawRef || undefined;
  const km = rawKm || undefined;
  // SSRF guard: scheme + private/loopback/link-local/metadata range blocking, resolving DNS. Redirect
  // targets are re-validated inside proxiedUpstream's plain-fetch path (followSafeRedirects).
  try {
    await assertUrlSafe(target);
  } catch (e) {
    if (e instanceof SsrfError) return reply.code(400).send({ error: `'url' rejected: ${e.message}` });
    return reply.code(400).send({ error: "invalid 'url' query param" });
  }

  // UniqueStream key.bin: send the load-bearing x-am-media-id header, then transform the body below.
  const isKeyBin = km && /key\.bin(\?|$)/.test(target);
  const extraHeaders = { ...(isKeyBin ? { 'x-am-media-id': km } : {}), ...(org ? { Origin: org } : {}) };

  let up;
  try {
    up = await proxiedUpstream(target, { referer: ref, range: req.headers.range, extraHeaders });
  } catch (e) {
    return reply.code(502).send({ error: `upstream fetch failed: ${e.message}` });
  }
  // tear down a spawned curl child if the client goes away mid-stream
  if (up.cleanup) reply.raw.on('close', up.cleanup);

  reply.header('Access-Control-Allow-Origin', '*');

  // key.bin → derive and return the real 16-byte AES-128 content key (the downstream HLS
  // engine then decrypts segments with it as a standard AES-128 key).
  if (isKeyBin) {
    try {
      const keyOut = deriveUniqueStreamKey(await up.text(), km);
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', String(keyOut.length));
      return reply.send(keyOut);
    } catch (e) {
      return reply.code(502).send({ error: `key.bin transform failed: ${e.message}` });
    } finally {
      if (up.cleanup) up.cleanup();
    }
  }

  const ct = up.getHeader('content-type') || '';
  const isPlaylist = ct.includes('mpegurl') || /\.m3u8(\?|$)/.test(target);

  if (isPlaylist) {
    // Only the playlist branch mints links, so only it needs a base — a segment/key/vtt passthrough
    // below is unaffected by a missing PUBLIC_URL and must not be broken by this check.
    const base = baseOr500(req, reply);
    if (base === null) return reply;
    const text = setDefaultAudio(deobfuscatePlaylist(await up.text(), pk), aud);
    reply.header('content-type', 'application/vnd.apple.mpegurl');
    return reply.send(rewriteM3U8(text, new URL(target), ref, base, pk, km, org, aud));
  }

  // segments / keys / vtt — stream through, preserving range/length headers
  reply.code(up.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = up.getHeader(h);
    if (v) reply.header(h, v);
  }
  return reply.send(up.nodeStream);
});

// ---- manga surface ----
// Registered from its own module so the video-proxy machinery above and the manga layer stay
// independently readable. The guards AND the aggregator are handed in rather than imported, so
// manga inherits the EXACT same API-key gate and per-IP tiers as the anime routes with no second
// implementation, and the routes module never reaches into consumet/dist itself.
// All five routes are live. /manga/image is a Referer-injecting, image-ONLY sibling of /proxy
// rather than a reuse of it: three of the six providers' CDNs cannot be linked directly at all
// (403 on a browser's Referer, or a placeholder when a CORS-mode load sends Origin) and the other
// three send no ACAO. It gets no `imageFetch` here, so it uses the real global fetch — that option
// exists only so the offline suite can drive the real SSRF/redirect/sniffing path without sockets.
// See api/src/manga-routes.mjs for the per-host measurements and the full rationale.
await app.register(mangaRoutes, { aggregator: mangaAgg, apiGuard, rateLimit });

app.setErrorHandler((err, _req, reply) => {
  app.log.error(err);
  reply.code(500).send({ error: err.message || 'internal error' });
});

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
