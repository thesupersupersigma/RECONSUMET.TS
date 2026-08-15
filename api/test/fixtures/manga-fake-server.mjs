// Test harness: the REAL api/src/manga-routes.mjs plugin, mounted on a throwaway Fastify app with a
// FAKE aggregator. Spawned by manga-wired.test.mjs, which then talks to it over HTTP — so the tests
// stay black-box (they exercise routing, param validation, status codes, headers and serialisation
// exactly as a client would) while remaining FULLY OFFLINE.
//
// This exists because api/test/manga-routes.test.mjs spawns the real server.mjs, whose aggregator is
// the real one: any test of a wired route there would hit AniList, MangaDex and four scrapers. The
// split is deliberate — that file keeps proving the things that must be true of the DEPLOYED server
// (routes mounted, params validated, SSRF guards live), this one proves the things that must be true
// of the WIRING (envelopes passed through, confidence preserved, Cache-Control derived, deadlines).
//
// The fake deliberately mimics MangaAggregator's real contract, including the bits that are easy to
// get wrong: `chapterNumber` is always a STRING, a null `provider` always carries a `reason`, and
// `getPages` runs every page URL through the INJECTED `imageProxy` (which is the real
// `mangaImageProxy` from the routes module) rather than inventing its own link format.
//
// Env: PORT (required), plus MANGA_TIMEOUT_MS / MANGA_READ_TIMEOUT_MS which the routes module reads.

import Fastify from 'fastify';
import mangaRoutes, { mangaImageProxy } from '../../src/manga-routes.mjs';

/** Never settles. Used to drive the wall-clock deadline without a sleep in the test. */
const forever = () => new Promise(() => {});

const page = (imageProxy, n, host, referer) => ({
  page: n,
  providerPage: n - 1, // providers number pages badly on purpose here; the aggregator re-derives
  img: imageProxy(`https://${host}/ch/1/${n}.jpg`, referer),
  rawImg: `https://${host}/ch/1/${n}.jpg`,
});

/**
 * A stand-in for MangaAggregator. Shapes come from the real `IMangaChaptersResult` /
 * `IMangaPagesResult` / `IMangaMapping` interfaces in consumet/src/providers/meta/manga-aggregator.ts.
 */
export const makeFakeAggregator = ({ imageProxy = raw => raw } = {}) => ({
  // Three real names + one policy-less provider, so the tests can prove the Cache-Control header is
  // read off the answer rather than hardcoded, and that an unknown name is a client error.
  providerNames: ['FakeDex', 'SlowScans', 'NoPolicy', 'HangScans', 'FetchScans'],

  async search(q, pageNum) {
    if (q === 'boom') throw new Error('AniList returned 429');
    if (q === 'hang') return forever();
    return [
      {
        id: '30013',
        malId: 13,
        title: { romaji: 'One Piece', english: 'One Piece', native: 'ONE PIECE' },
        image: 'https://cdn.example/op.jpg',
        totalChapters: undefined, // RELEASING → AniList says null. Never a count backstop.
        type: 'MANGA',
        status: 'RELEASING',
        echoPage: pageNum,
      },
    ];
  },

  async getMappings(anilistId) {
    if (String(anilistId) === '999') throw new Error('AniList upstream exploded');
    if (String(anilistId) === '777') return forever();
    if (String(anilistId) === '1') return [];
    // Confidence-first order, exactly as the aggregator sorts them.
    return [
      {
        provider: 'FakeDex',
        id: 'a1c7c817-4e59-43b7-9365-09675a149a6f',
        title: 'One Piece',
        score: 1,
        matchConfidence: 'exact-id',
        via: 'mangadex-links.al',
      },
      { provider: 'SlowScans', id: 'one-piece', title: 'One Piece', score: 1, matchConfidence: 'metadata' },
      {
        provider: 'NoPolicy',
        id: '8136/one-piece-novel',
        title: 'One Piece Novel',
        score: 0.91,
        matchConfidence: 'unverified',
      },
    ];
  },

  async getChapters(anilistId, opts = {}) {
    const id = String(anilistId);
    if (id === '999') throw new Error('metadata resolve exploded');
    if (id === '777') return forever();
    const lang = (opts.lang ?? 'en').toLowerCase();
    if (id === '404')
      // The contract that matters most: a null provider ALWAYS carries a reason.
      return {
        provider: null,
        matchConfidence: null,
        lang,
        chapters: [],
        reason: `no registered provider serves language '${lang}' for this title — skipped: FakeDex (serves en)`,
      };
    return {
      // Echoed so the test can prove ?provider= actually reached the aggregator.
      provider: opts.provider ?? 'FakeDex',
      providerId: 'a1c7c817-4e59-43b7-9365-09675a149a6f',
      matchConfidence: 'metadata',
      via: undefined,
      lang,
      chapters: [
        { id: 'ch-1105', title: 'Chapter 1105', chapterNumber: '1105', lang, pages: 17, releaseDate: '2026-08-01' },
        // The three shapes that break any Number() coercion.
        { id: 'ch-100-5', title: 'Chapter 100.5', chapterNumber: '100.5', volumeNumber: '11', lang },
        { id: 'ch-extra', title: 'Extra', chapterNumber: 'Extra', lang },
        { id: 'ch-oneshot', title: 'Oneshot', chapterNumber: 'Oneshot', lang },
        {
          id: 'ch-1106',
          title: 'Chapter 1106',
          chapterNumber: '1106',
          lang,
          unavailable: { reason: 'external', detail: 'https://example.com/elsewhere' },
        },
        {
          id: 'ch-1107',
          title: 'Chapter 1107',
          chapterNumber: '1107',
          lang,
          unavailable: { reason: 'locked', detail: '2026-08-15T00:05:00Z' },
        },
      ],
    };
  },

  async getPages(providerName, chapterId, opts = {}) {
    if (chapterId === 'boom') throw new Error('chapter fetch exploded');
    if (providerName === 'HangScans') return forever();
    // Models the real provider behaviour the SSRF guard exists for: several manga (and anime)
    // providers treat a chapterId that starts with 'http' as a URL and fetch it directly. If the
    // guard in /manga/read is ever removed, THIS is what a private chapterId reaches — so the
    // canary test in manga-wired.test.mjs is a real blind-SSRF probe, not a status-code assertion.
    if (providerName === 'FetchScans') {
      if (/^https?:/i.test(chapterId)) {
        const body = await (await fetch(chapterId)).text();
        return { provider: 'FetchScans', chapterId, leaked: body, pages: [], cache: { ttlSeconds: 0, immutable: false, note: 'probe' } };
      }
      return { provider: 'FetchScans', chapterId, pages: [], cache: { ttlSeconds: 0, immutable: false, note: 'probe' } };
    }
    if (providerName === 'SlowScans') {
      const referer = 'https://slow.example/';
      return {
        provider: 'SlowScans',
        chapterId,
        pages: [1, 2].map(n => page(imageProxy, n, 'cdn.slow.example', referer)),
        headers: { Referer: referer },
        // Content-addressed CDN: a year, immutable. The opposite end of the range from FakeDex.
        cache: { ttlSeconds: 31536000, immutable: true, note: 'content-addressed path, confirmed stable' },
      };
    }
    if (providerName === 'NoPolicy')
      // A provider that states no cache policy at all — the route must not invent one.
      return { provider: 'NoPolicy', chapterId, pages: [page(imageProxy, 1, 'cdn.nopolicy.example')] };
    return {
      provider: 'FakeDex',
      chapterId,
      echoLang: opts.lang,
      pages: [1, 2, 3].map(n => page(imageProxy, n, 'cdn.fake.example')),
      // MangaDex-shaped: a per-request host that dies in ~15 minutes.
      cache: { ttlSeconds: 600, immutable: false, note: 'at-home host valid ~15 min' },
    };
  },
});

// =============================================================================================
// THE FAKE SOCKET LAYER FOR /manga/image
// =============================================================================================
//
// The route's fetch is injectable (`opts.imageFetch`) for the same reason `fetchImpl` and `lookup`
// already are in ssrf-guard.mjs: there is NO way to test the success path otherwise. A real local
// upstream must live on 127.0.0.1, and 127.0.0.1 is precisely what assertUrlSafe blocks — so a
// suite that only used real sockets could prove rejection and nothing else.
//
// What is faked is ONLY the socket. `assertUrlSafe`, the redirect walk in `followSafeRedirects`,
// the content sniffing, the size ceiling and the header handling are all the REAL code paths. The
// synthetic upstream lives on the literal public IP 1.1.1.1, which assertUrlSafe accepts without
// touching DNS, and no packet is ever sent to it.
//
// CRITICALLY, THIS FAKE HONOURS `init.redirect`. That is what makes the redirect-SSRF test a real
// probe instead of a status-code assertion: if someone rewrites the route as a plain
// `fetch(url, { redirect: 'follow' })`, this fake follows the Location ITSELF — straight to the
// loopback canary, with a real socket and a real body — and the canary test fails. With
// followSafeRedirects (redirect: 'manual') the 302 comes back here, gets re-validated, and is
// refused before anything is contacted.
//
// Env: IMAGE_CANARY_URL — a loopback URL that must never be contacted.

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 0x41)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600, 0x42),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.alloc(600, 0x43),
]);
const HTML = Buffer.from('<!DOCTYPE html><html><body>Sorry, you have been blocked</body></html>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** Every header set the route sent upstream, newest last. Read back over HTTP by the tests. */
export const imageCalls = [];

const CANARY = process.env.IMAGE_CANARY_URL || '';

/** A Response whose body is a real web ReadableStream, delivered in small chunks so the route's
 *  head-read loop and its streaming ceiling both run for real rather than seeing one big chunk. */
const streamed = (bytes, headers, { status = 200, chunk = 64 } = {}) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.subarray(i, i + chunk));
        controller.close();
      },
    }),
    { status, headers }
  );

const ROUTES = {
  // The ordinary case: a JPEG that says it is a JPEG.
  '/ok.jpg': () => streamed(JPEG, { 'content-type': 'image/jpeg', 'content-length': String(JPEG.length) }),
  // A CDN that states its own cache policy — the route must mirror it, not invent one.
  '/cached.webp': () =>
    streamed(WEBP, { 'content-type': 'image/webp', 'cache-control': 'public, max-age=31536000, immutable', etag: '"abc"' }),
  // No cache-control at all → the route's own conservative default.
  '/nocache.png': () => streamed(PNG, { 'content-type': 'image/png' }),
  // THE WEEBCENTRAL TRAP, byte for byte: a `.png` url, `Content-Type: image/png`, JPEG bytes.
  '/lying.png': () => streamed(JPEG, { 'content-type': 'image/png' }),
  // A block page that admits what it is.
  '/blocked': () => streamed(HTML, { 'content-type': 'text/html; charset=UTF-8' }),
  // A block page that LIES about what it is — only sniffing catches this one.
  '/liar.jpg': () => streamed(HTML, { 'content-type': 'image/jpeg' }),
  // Script-bearing SVG from an origin the browser would treat as ours. Must never be relayed.
  '/xss.svg': () => streamed(SVG, { 'content-type': 'image/svg+xml' }),
  // 403 + a Cloudflare-shaped HTML body. Neither the status nor the body may be relayed.
  '/403': () => streamed(HTML, { 'content-type': 'text/html' }, { status: 403 }),
  '/empty.jpg': () => streamed(Buffer.alloc(0), { 'content-type': 'image/jpeg' }),
  // Declares a length over the ceiling: must be refused WITHOUT reading the body.
  '/toobig-declared.jpg': () =>
    streamed(JPEG, { 'content-type': 'image/jpeg', 'content-length': String(50 * 1024 * 1024) }),
  // Declares nothing and then streams past the ceiling: only the byte counter catches this.
  '/toobig-stream.jpg': () =>
    streamed(Buffer.concat([JPEG, Buffer.alloc(64 * 1024, 0x44)]), { 'content-type': 'image/jpeg' }),
  // A redirect that stays public — must be followed, transparently.
  '/redir-public': () => new Response(null, { status: 302, headers: { location: 'https://1.1.1.1/ok.jpg' } }),
  // A redirect INTO the blocked range. The whole point.
  '/redir-private': () => new Response(null, { status: 302, headers: { location: CANARY } }),
};

/**
 * @type {typeof fetch}
 */
const fakeImageFetch = async (url, init = {}) => {
  const u = new URL(String(url));
  imageCalls.push({ url: u.href, headers: Object.fromEntries(Object.entries(init.headers ?? {})) });

  // The leak path. Reached ONLY if a guard is missing — either the initial assertUrlSafe, or the
  // per-hop one inside followSafeRedirects. A real socket, a real body, a real hit counter.
  if (u.hostname === '127.0.0.1') return globalThis.fetch(url, { ...init, redirect: 'manual' });

  const make = ROUTES[u.pathname];
  if (!make) return new Response('no such fixture', { status: 404 });
  const res = make();

  // Emulate undici's own redirect handling, so a route that stopped using followSafeRedirects
  // behaves here exactly as it would in production: it follows, and it reaches the canary.
  if (res.status >= 300 && res.status < 400 && init.redirect !== 'manual') {
    const loc = res.headers.get('location');
    if (loc) return fakeImageFetch(new URL(loc, u).href, init);
  }
  return res;
};

const app = Fastify({ logger: false });
await app.register(mangaRoutes, {
  aggregator: makeFakeAggregator({ imageProxy: mangaImageProxy }),
  imageFetch: fakeImageFetch,
});
// Read back the headers the route sent upstream. Not part of the plugin — a fixture-only endpoint,
// so the "no Origin was ever sent" assertion is made against what actually left the process rather
// than against a mock the test itself wrote.
app.get('/__image-calls', async () => imageCalls);
await app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
