// Thin HTTP API over the anime aggregator, with a Referer-injecting HLS/subtitle
// proxy so streams play in a browser. Self-host first; rebrand before going public.
//
// Env:
//   PORT           (default 3000)
//   CLOAK_CDP_URL  cloakbrowser CDP endpoint (default http://localhost:9222) — needed for
//                  Gogoanime episode lists. Search/info/sources work without it.
//   PUBLIC_URL     public base url used when building proxy links (default derived from request)
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Readable } from 'node:stream';
import pkg from '../../consumet/dist/index.js';

const { AnimeAggregator } = pkg;

const PORT = Number(process.env.PORT) || 3000;
const CLOAK = process.env.CLOAK_CDP_URL || 'http://localhost:9222';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const app = Fastify({ logger: true });
await app.register(cors, { origin: '*' });

const agg = new AnimeAggregator();

const cloakReachable = async () => {
  try {
    return (await fetch(`${CLOAK}/json/version`, { signal: AbortSignal.timeout(4000) })).ok;
  } catch {
    return false;
  }
};

const proxyBase = req => process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`;
const wrapUrl = (base, url, ref) =>
  `${base}/proxy?url=${encodeURIComponent(url)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;

// rewrite an HLS playlist so every segment / sub-playlist / key goes back through the proxy
const rewriteM3U8 = (text, baseUrl, ref, base) => {
  const wrap = u => wrapUrl(base, new URL(u, baseUrl).href, ref);
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

// ---- meta / scraping routes ----

app.get('/', async () => ({
  name: 'anime-api',
  status: 'ok',
  cloakbrowser: (await cloakReachable()) ? 'reachable' : 'UNREACHABLE — Gogoanime episodes need it',
  providers: agg.providers.map(p => p.name),
  routes: {
    search: 'GET /search?q=<query>&page=1',
    info: 'GET /info/:anilistId   (provider mappings = available sources)',
    episodes: 'GET /episodes/:anilistId?provider=Gogoanime',
    watch: 'GET /watch?provider=Gogoanime&episodeId=<id>&type=sub   (returns browser-ready proxied urls)',
    proxy: 'GET /proxy?url=<encoded>&ref=<encoded referer>',
  },
}));

app.get('/search', async (req, reply) => {
  const q = req.query.q;
  if (!q) return reply.code(400).send({ error: "missing 'q' query param" });
  return { results: await agg.search(q, Number(req.query.page) || 1) };
});

app.get('/info/:anilistId', async req => ({
  id: req.params.anilistId,
  mappings: await agg.getMappings(req.params.anilistId),
}));

app.get('/episodes/:anilistId', async req =>
  agg.getEpisodes(req.params.anilistId, req.query.provider)
);

// sources, with m3u8 + subtitle urls pre-wrapped through the proxy (ready for hls.js)
app.get('/watch', async (req, reply) => {
  const { provider, episodeId, type } = req.query;
  if (!provider || !episodeId) {
    return reply.code(400).send({ error: "missing 'provider' and/or 'episodeId' query params" });
  }
  const src = await agg.getSources(provider, episodeId, undefined, type === 'dub' ? 'dub' : 'sub');
  const ref = src.headers?.Referer;
  const base = proxyBase(req);
  const wrap = u => (u ? wrapUrl(base, u, ref) : u);
  return {
    sources: (src.sources ?? []).map(s => ({ ...s, url: wrap(s.url), rawUrl: s.url })),
    subtitles: (src.subtitles ?? []).map(s => ({ ...s, url: wrap(s.url), rawUrl: s.url })),
    intro: src.intro,
    outro: src.outro,
    headers: src.headers,
  };
});

// ---- referer-injecting HLS / segment / subtitle proxy ----

app.get('/proxy', async (req, reply) => {
  const target = req.query.url;
  const ref = req.query.ref;
  if (!target) return reply.code(400).send({ error: "missing 'url' query param" });

  const headers = { 'User-Agent': UA };
  if (ref) headers.Referer = ref;
  if (req.headers.range) headers.Range = req.headers.range; // seeking

  let upstream;
  try {
    upstream = await fetch(target, { headers, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return reply.code(502).send({ error: `upstream fetch failed: ${e.message}` });
  }

  reply.header('Access-Control-Allow-Origin', '*');
  const ct = upstream.headers.get('content-type') || '';
  const isPlaylist = ct.includes('mpegurl') || /\.m3u8(\?|$)/.test(target);

  if (isPlaylist) {
    const text = await upstream.text();
    reply.header('content-type', 'application/vnd.apple.mpegurl');
    return reply.send(rewriteM3U8(text, new URL(target), ref, proxyBase(req)));
  }

  // segments / keys / vtt — stream through, preserving range/length headers
  reply.code(upstream.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) reply.header(h, v);
  }
  return reply.send(upstream.body ? Readable.fromWeb(upstream.body) : null);
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
