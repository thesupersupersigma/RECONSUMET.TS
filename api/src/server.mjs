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
//   PUBLIC_URL             public base url used when building /proxy links (default derived from the request);
//                          set to the tunnel/public origin so rewritten playlists point back at us, not localhost.
//   CURL_IMPERSONATE_BIN   path to a curl-impersonate binary/wrapper (e.g. .../curl-impersonate). When set,
//                          fetches to TLS_IMPERSONATE_HOSTS go through it to clear Cloudflare JA3 gates.
//                          When empty, TLS impersonation silently no-ops (plain fetch → those hosts 403).
//   CURL_IMPERSONATE_ARGS  extra args for the binary (e.g. "--impersonate chrome124" for the single-binary
//                          builds; leave empty when using the curl_chromeNNN wrapper scripts).
//   TLS_IMPERSONATE_HOSTS  comma-list of host suffixes routed through curl-impersonate (default flixcloud.cc,overcdn.site)
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import pkg from '../../consumet/dist/index.js';

const { AnimeAggregator } = pkg;

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
};
const API_KEY = process.env.API_KEY || ''; // OFF by default — set to require auth on data routes
const DEBUG_INFO = /^(1|true)$/i.test(process.env.DEBUG_INFO || '');

// trustProxy scoped to our own proxy hop (see RL_TRUST_PROXY above): the socket IP is Traefik's,
// so we resolve the real client IP from X-Forwarded-For for per-IP keying — but only trusting
// our proxy's ranges, so a caller can't forge req.ip by injecting XFF entries.
const app = Fastify({ logger: true, trustProxy: RL_TRUST_PROXY });
// CORS '*' is INTENTIONAL: a public, read-only metadata/stream API called from arbitrary
// frontends; no cookies/credentials are used. Tighten only if you add origin-dependent auth.
await app.register(cors, { origin: '*' });

const agg = new AnimeAggregator();

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
const isNumericId = v => /^\d+$/.test(String(v ?? ''));
const isHttpUrl = v => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

// ---- proxy link building + HLS rewrite ----

const proxyBase = req => process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`;
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
      const target = new RegExp(`LANGUAGE="${aud}"`, 'i').test(line);
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
  const r = await fetch(target, { headers, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
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

app.get('/', async () => {
  const base = {
    name: 'anime-api',
    status: 'ok',
    providers: agg.providers.map(p => p.name),
    routes: {
      search: 'GET /search?q=<query>&page=1',
      info: 'GET /info/:anilistId   (provider mappings = available sources)',
      episodes: 'GET /episodes/:anilistId?provider=Gogoanime',
      watch: 'GET /watch?provider=Gogoanime&episodeId=<id>   (returns proxied sources for sub and dub)',
      proxy: 'GET /proxy?url=<encoded>&ref=<encoded referer>&pk=<encoded>   (HLS/segment/subtitle proxy)',
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

  const base = proxyBase(req);
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
  const ref = req.query.ref;
  const pk = req.query.pk;
  const km = req.query.km;
  const org = req.query.org; // segment-CDN Origin (KickAssAnime segments 403 without it)
  const aud = req.query.aud; // default-audio language for the HLS master (KickAssAnime dub)
  if (!target) return reply.code(400).send({ error: "missing 'url' query param" });
  if (!isHttpUrl(target)) return reply.code(400).send({ error: "'url' must be an http(s) URL" });

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
    const text = setDefaultAudio(deobfuscatePlaylist(await up.text(), pk), aud);
    reply.header('content-type', 'application/vnd.apple.mpegurl');
    return reply.send(rewriteM3U8(text, new URL(target), ref, proxyBase(req), pk, km, org, aud));
  }

  // segments / keys / vtt — stream through, preserving range/length headers
  reply.code(up.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = up.getHeader(h);
    if (v) reply.header(h, v);
  }
  return reply.send(up.nodeStream);
});

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
