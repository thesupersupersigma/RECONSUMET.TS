// Thin HTTP API over the anime aggregator, with a Referer-injecting HLS/subtitle
// proxy so streams play in a browser. Self-host first; rebrand before going public.
//
// Env:
//   PORT                   (default 3000)
//   CLOAK_CDP_URL          cloakbrowser CDP endpoint (default http://localhost:9222) — needed for
//                          Gogoanime episode lists. Search/info/sources work without it.
//   PUBLIC_URL             public base url used when building proxy links (default derived from request)
//   CURL_IMPERSONATE_BIN   path to a curl-impersonate binary/wrapper (e.g. .../curl_chrome116). When set,
//                          fetches to TLS_IMPERSONATE_HOSTS go through it to clear Cloudflare JA3 gates.
//   CURL_IMPERSONATE_ARGS  extra args for the binary (e.g. "--impersonate chrome116" for the single-binary
//                          builds; leave empty when using the curl_chromeNNN wrapper scripts).
//   TLS_IMPERSONATE_HOSTS  comma-list of host suffixes routed through curl-impersonate (default flixcloud.cc)
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import pkg from '../../consumet/dist/index.js';

const { AnimeAggregator } = pkg;

const PORT = Number(process.env.PORT) || 3000;
const CLOAK = process.env.CLOAK_CDP_URL || 'http://localhost:9222';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// --- TLS-impersonation (curl-impersonate) config ---
const CURL_BIN = process.env.CURL_IMPERSONATE_BIN || '';
const CURL_ARGS = (process.env.CURL_IMPERSONATE_ARGS || '').split(' ').filter(Boolean);
const TLS_HOSTS = (process.env.TLS_IMPERSONATE_HOSTS || 'flixcloud.cc,overcdn.site')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

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
const wrapUrl = (base, url, ref, pk) =>
  `${base}/proxy?url=${encodeURIComponent(url)}` +
  `${ref ? `&ref=${encodeURIComponent(ref)}` : ''}` +
  `${pk ? `&pk=${encodeURIComponent(pk)}` : ''}`;

// rewrite an HLS playlist so every segment / sub-playlist / key goes back through the
// proxy. `pk` (if set) is propagated so child playlists are de-obfuscated too.
const rewriteM3U8 = (text, baseUrl, ref, base, pk) => {
  const wrap = u => wrapUrl(base, new URL(u, baseUrl).href, ref, pk);
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
const impersonatedFetch = (target, { referer, range }) =>
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
    };
    const args = [...CURL_ARGS, '-sS', '-N', '--max-time', '30', '-D', '/dev/fd/3'];
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
const proxiedUpstream = async (target, { referer, range }) => {
  if (needsImpersonation(target)) {
    const r = await impersonatedFetch(target, { referer, range });
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
  const r = await fetch(target, { headers, signal: AbortSignal.timeout(30000) });
  return {
    status: r.status,
    getHeader: name => r.headers.get(name),
    text: () => r.text(),
    nodeStream: r.body ? Readable.fromWeb(r.body) : null,
    cleanup: null,
  };
};

// ---- meta / scraping routes ----

app.get('/', async () => ({
  name: 'anime-api',
  status: 'ok',
  cloakbrowser: (await cloakReachable()) ? 'reachable' : 'UNREACHABLE — Gogoanime episodes need it',
  tlsImpersonation: CURL_BIN ? { enabled: true, hosts: TLS_HOSTS } : { enabled: false },
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
  // m3u8 sources may need a playlist-deobfuscation key (src.pk); subtitles never do.
  const wrap = (u, pk) => (u ? wrapUrl(base, u, ref, pk) : u);
  return {
    sources: (src.sources ?? []).map(s => ({ ...s, url: wrap(s.url, src.pk), rawUrl: s.url })),
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
  const pk = req.query.pk;
  if (!target) return reply.code(400).send({ error: "missing 'url' query param" });

  let up;
  try {
    up = await proxiedUpstream(target, { referer: ref, range: req.headers.range });
  } catch (e) {
    return reply.code(502).send({ error: `upstream fetch failed: ${e.message}` });
  }
  // tear down a spawned curl child if the client goes away mid-stream
  if (up.cleanup) reply.raw.on('close', up.cleanup);

  reply.header('Access-Control-Allow-Origin', '*');
  const ct = up.getHeader('content-type') || '';
  const isPlaylist = ct.includes('mpegurl') || /\.m3u8(\?|$)/.test(target);

  if (isPlaylist) {
    const text = deobfuscatePlaylist(await up.text(), pk);
    reply.header('content-type', 'application/vnd.apple.mpegurl');
    return reply.send(rewriteM3U8(text, new URL(target), ref, proxyBase(req), pk));
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
