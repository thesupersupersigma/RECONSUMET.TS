// Thin HTTP API over the anime aggregator. Self-host first; rebrand before going public.
//
// Env:
//   PORT           (default 3000)
//   CLOAK_CDP_URL  cloakbrowser CDP endpoint (default http://localhost:9222) — needed for
//                  Gogoanime episode lists. Search/info/sources work without it.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from '../../consumet/dist/index.js';

const { AnimeAggregator } = pkg;

const PORT = Number(process.env.PORT) || 3000;
const CLOAK = process.env.CLOAK_CDP_URL || 'http://localhost:9222';

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

// health / index
app.get('/', async () => ({
  name: 'anime-api',
  status: 'ok',
  cloakbrowser: (await cloakReachable()) ? 'reachable' : 'UNREACHABLE — Gogoanime episodes need it',
  providers: agg.providers.map(p => p.name),
  routes: {
    search: 'GET /search?q=<query>&page=1',
    info: 'GET /info/:anilistId   (provider mappings = available sources)',
    episodes: 'GET /episodes/:anilistId?provider=Gogoanime',
    watch: 'GET /watch?provider=Gogoanime&episodeId=<id>&type=sub',
  },
}));

// AniList search (no scraping)
app.get('/search', async (req, reply) => {
  const q = req.query.q;
  if (!q) return reply.code(400).send({ error: "missing 'q' query param" });
  return { results: await agg.search(q, Number(req.query.page) || 1) };
});

// provider mappings for an AniList id = the list of sources a client can choose
app.get('/info/:anilistId', async req => ({
  id: req.params.anilistId,
  mappings: await agg.getMappings(req.params.anilistId),
}));

// episodes (preferred provider, with fallback) — pass ?provider= to force one
app.get('/episodes/:anilistId', async req =>
  agg.getEpisodes(req.params.anilistId, req.query.provider)
);

// resolve sources for an episode (m3u8 + subtitles + required headers)
app.get('/watch', async (req, reply) => {
  const { provider, episodeId, type } = req.query;
  if (!provider || !episodeId) {
    return reply.code(400).send({ error: "missing 'provider' and/or 'episodeId' query params" });
  }
  return agg.getSources(provider, episodeId, undefined, type === 'dub' ? 'dub' : 'sub');
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
