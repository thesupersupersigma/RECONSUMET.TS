// Self-hosted HTTP API over the anime aggregator. Returns raw stream sources for both
// sub and dub in a single /watch call. Internal name: "anime-api".
//
// Env:
//   PORT                   (default 3000; production runs on 4000 via env)
//   RATE_LIMIT_MAX         per-IP/min for cheap routes (/search), default 120; 0 disables that tier
//   RATE_LIMIT_SCRAPE      per-IP/min for live-scraping routes (/info,/episodes), default 60
//   RATE_LIMIT_WATCH       per-IP/min for /watch (extractor), default 30
//   RATE_LIMIT_WINDOW      rate-limit window in seconds (default 60)
//   RATE_LIMIT_TRUST_PROXY trust X-Forwarded-For for client IP (default true; needed behind CF / SSR frontends)
//   API_KEY                if set, /search /info /episodes /watch require it (x-api-key or Bearer). OFF by default.
//   DEBUG_INFO             if "1"/"true", the / route also exposes cloakbrowser diagnostics (off by default)
//   HTTP_TIMEOUT_MS        (consumet lib) AniList/provider axios timeout (ms, default 20000)
//   CLOAK_CDP_URL          cloakbrowser CDP endpoint (default http://localhost:9222) — needed for
//                          Gogoanime episode lists. Search/info/sources work without it.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from '../../consumet/dist/index.js';

const { AnimeAggregator } = pkg;

const PORT = Number(process.env.PORT) || 3000; // explicit default 3000; production sets PORT=4000
const CLOAK = process.env.CLOAK_CDP_URL || 'http://localhost:9222';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// --- rate limiting (tiered, in-memory) + optional API key ---
const RL_WINDOW_MS = (Number(process.env.RATE_LIMIT_WINDOW) || 60) * 1000;
const RATE_LIMIT_TRUST_PROXY = (process.env.RATE_LIMIT_TRUST_PROXY ?? 'true').toLowerCase() !== 'false';
const RL_TIERS = {
  default: Number(process.env.RATE_LIMIT_MAX ?? 120),
  scrape: Number(process.env.RATE_LIMIT_SCRAPE ?? 60),
  watch: Number(process.env.RATE_LIMIT_WATCH ?? 30),
};
const API_KEY = process.env.API_KEY || ''; // OFF by default — set to require auth on data routes
const DEBUG_INFO = /^(1|true)$/i.test(process.env.DEBUG_INFO || '');

// trustProxy: behind Cloudflare / an SSR frontend the socket IP is the proxy's; trust
// X-Forwarded-For so rate limiting keys on the real client IP (toggle via RATE_LIMIT_TRUST_PROXY).
const app = Fastify({ logger: true, trustProxy: RATE_LIMIT_TRUST_PROXY });
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

const cloakReachable = async () => {
  try {
    return (await fetch(`${CLOAK}/json/version`, { signal: AbortSignal.timeout(4000) })).ok;
  } catch {
    return false;
  }
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
      watch: 'GET /watch?provider=Gogoanime&episodeId=<id>   (returns raw sources for sub and dub)',
    },
  };
  // VM internals (cloakbrowser reachability) only when DEBUG_INFO is set
  if (!DEBUG_INFO) return base;
  return {
    ...base,
    cloakbrowser: (await cloakReachable()) ? 'reachable' : 'UNREACHABLE — Gogoanime episodes need it',
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

// raw sources for both sub and dub, fetched concurrently and returned together.
// Each type is null if it was rejected or yielded zero sources; 502 only if both are null.
app.get('/watch', { preHandler: apiGuard('watch') }, async (req, reply) => {
  const { provider, episodeId } = req.query;
  if (!provider || !episodeId) {
    return reply.code(400).send({ error: "missing 'provider' and/or 'episodeId' query params" });
  }

  // shape a single getSources result into the response object, or null if it has no sources.
  const shape = src => {
    if (!src || !(src.sources?.length)) return null;
    const out = { sources: src.sources, subtitles: src.subtitles ?? [] };
    if (src.headers != null) out.headers = src.headers;
    if (src.intro != null) out.intro = src.intro;
    if (src.outro != null) out.outro = src.outro;
    if (src.pk != null) out.pk = src.pk;
    return out;
  };

  const [subRes, dubRes] = await Promise.allSettled([
    agg.getSources(provider, episodeId, undefined, 'sub'),
    agg.getSources(provider, episodeId, undefined, 'dub'),
  ]);

  if (subRes.status === 'rejected') app.log.warn({ provider: req.query.provider, err: subRes.reason?.message }, 'sub getSources failed');
  if (dubRes.status === 'rejected') app.log.warn({ provider: req.query.provider, err: dubRes.reason?.message }, 'dub getSources failed');

  const sub = subRes.status === 'fulfilled' ? shape(subRes.value) : null;
  const dub = dubRes.status === 'fulfilled' ? shape(dubRes.value) : null;

  if (!sub && !dub) {
    return reply.code(502).send({ error: 'no sources found for sub or dub' });
  }
  return { sub, dub };
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
