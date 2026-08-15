// Black-box tests for the four WIRED manga routes (/manga/search, /manga/info, /manga/chapters,
// /manga/read). /manga/image is covered by manga-image.test.mjs, which spawns this same harness
// with a faked socket layer.
//
// Two servers are involved, on purpose:
//   1. fixtures/manga-fake-server.mjs — the REAL routes plugin with a FAKE aggregator, spawned on a
//      free loopback port. This is where the wiring is proved: envelopes, matchConfidence, reason,
//      chapterNumber-stays-a-string, per-provider Cache-Control, 400/502/504, the SSRF guard
//      standing in front of a handler that WOULD have answered 200.
//   2. No real server here. api/test/manga-routes.test.mjs keeps that job — spawning src/server.mjs
//      and proving the deployed shape, which cannot exercise the wired routes without hitting
//      AniList and four scrapers.
//
// Plus one in-process test against the REAL MangaAggregator from consumet/dist, with a fake parser,
// proving the `imageProxy` seam is actually the thing that mints pages[].img. That is the one part
// of the wiring a fake aggregator cannot prove, and it needs no network.
//
// Fully offline. Run: cd api && node --test 'test/**/*.test.mjs'

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cacheControlFor, createMangaAggregator, mangaImageProxy } from '../src/manga-routes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'fixtures', 'manga-fake-server.mjs');

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let child;
let base;
let log = '';
let canary;
let canaryHits = 0;
let canaryUrl;

before(async () => {
  const canaryPort = await freePort();
  canary = http.createServer((_req, res) => {
    canaryHits++;
    res.end('SECRET-CANARY-BODY');
  });
  await new Promise(r => canary.listen(canaryPort, '127.0.0.1', r));
  canaryUrl = `http://127.0.0.1:${canaryPort}/chapter-1`;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [HARNESS], {
    env: {
      ...process.env,
      PORT: String(port),
      // Short deadlines so the 504 tests take milliseconds instead of a minute. Everything else the
      // fake does is in-memory, so nothing legitimate can race these.
      MANGA_TIMEOUT_MS: '400',
      MANGA_READ_TIMEOUT_MS: '400',
      // Unset so the img links must be derived from the REQUEST's host, which is what the deployed
      // default does when PUBLIC_URL is not configured.
      PUBLIC_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => (log += d));
  child.stderr.on('data', d => (log += d));

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`harness exited early (${child.exitCode}):\n${log}`);
    try {
      const r = await fetch(`${base}/manga/image`); // 400 (missing url) — any answer means listening
      await r.arrayBuffer();
      break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`harness never came up:\n${log}`);
    await new Promise(r => setTimeout(r, 100));
  }
}, { timeout: 60_000 });

after(async () => {
  child?.kill('SIGKILL');
  await new Promise(r => canary?.close(r));
});

const get = async route => {
  const res = await fetch(`${base}${route}`);
  const body = await res.json();
  return { res, body };
};

// ------------------------------------------------------------------ /manga/search

test('/manga/search returns { results } from the aggregator, not a 501', async () => {
  const { res, body } = await get('/manga/search?q=one%20piece');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.results), 'results is not an array');
  assert.equal(body.results[0].id, '30013');
  // The AniList MANGA id space. 21 is the ANIME One Piece and must never appear here.
  assert.notEqual(body.results[0].id, '21');
  // AniList reports chapters:null for a RELEASING series; the route must not manufacture a count.
  assert.ok(!('totalChapters' in body.results[0]) || body.results[0].totalChapters === undefined);
});

test('/manga/search forwards the page number', async () => {
  const { body } = await get('/manga/search?q=one%20piece&page=3');
  assert.equal(body.results[0].echoPage, 3);
});

test('/manga/search maps an upstream throw to 502, mirroring GET /search', async () => {
  const { res, body } = await get('/manga/search?q=boom');
  assert.equal(res.status, 502);
  assert.match(body.error, /manga search upstream failed: AniList returned 429/);
});

test('/manga/search maps a hung upstream to 504, not 502 and not a held connection', async () => {
  const { res, body } = await get('/manga/search?q=hang');
  assert.equal(res.status, 504);
  assert.match(body.error, /manga search timed out: .*exceeded 400ms/);
});

// ------------------------------------------------------------------ /manga/info

test('/manga/info returns { id, mappings } with matchConfidence and via intact', async () => {
  const { res, body } = await get('/manga/info/30013');
  assert.equal(res.status, 200);
  assert.equal(body.id, '30013');
  assert.equal(body.mappings.length, 3);
  // THE point of the manga surface: the confidence label survives to the client, verbatim.
  assert.deepEqual(
    body.mappings.map(m => m.matchConfidence),
    ['exact-id', 'metadata', 'unverified']
  );
  assert.equal(body.mappings[0].via, 'mangadex-links.al');
  // `via` is only meaningful for 'exact-id' and must not be invented for the others.
  assert.ok(!('via' in body.mappings[1]), 'a non-bridged mapping grew a `via`');
  // Confidence-first order is the aggregator's; re-sorting here would hand a client the
  // best-SPELLED match instead of the best-EVIDENCED one.
  assert.equal(body.mappings[0].provider, 'FakeDex');
});

test('/manga/info answers 200 with an empty mapping list rather than 404', async () => {
  const { res, body } = await get('/manga/info/1');
  assert.equal(res.status, 200);
  assert.deepEqual(body, { id: '1', mappings: [] });
});

test('/manga/info maps an upstream throw to 502 and a hang to 504', async () => {
  const bad = await get('/manga/info/999');
  assert.equal(bad.res.status, 502);
  assert.match(bad.body.error, /manga mapping upstream failed: AniList upstream exploded/);
  const hung = await get('/manga/info/777');
  assert.equal(hung.res.status, 504);
  assert.match(hung.body.error, /manga mapping timed out/);
});

// ------------------------------------------------------------------ /manga/chapters

test('/manga/chapters returns the aggregator envelope verbatim', async () => {
  const { res, body } = await get('/manga/chapters/30013');
  assert.equal(res.status, 200);
  assert.equal(body.provider, 'FakeDex');
  assert.equal(body.providerId, 'a1c7c817-4e59-43b7-9365-09675a149a6f');
  assert.equal(body.matchConfidence, 'metadata');
  assert.equal(body.lang, 'en');
  assert.equal(body.chapters.length, 6);
});

test('/manga/chapters keeps chapterNumber a STRING for every shape providers emit', async () => {
  const { body } = await get('/manga/chapters/30013');
  const numbers = body.chapters.map(c => c.chapterNumber);
  for (const n of numbers) assert.equal(typeof n, 'string', `${JSON.stringify(n)} is not a string`);
  // The three that any Number() coercion destroys: 100.5 (reordered by a numeric sort), and two
  // that become NaN.
  assert.ok(numbers.includes('100.5'), 'the decimal chapter lost its exact form');
  assert.ok(numbers.includes('Extra'));
  assert.ok(numbers.includes('Oneshot'));
});

test('/manga/chapters surfaces unavailability so a client can grey a chapter out', async () => {
  const { body } = await get('/manga/chapters/30013');
  const byId = Object.fromEntries(body.chapters.map(c => [c.id, c]));
  assert.deepEqual(byId['ch-1106'].unavailable, {
    reason: 'external',
    detail: 'https://example.com/elsewhere',
  });
  assert.deepEqual(byId['ch-1107'].unavailable, { reason: 'locked', detail: '2026-08-15T00:05:00Z' });
  // A readable chapter must NOT carry the flag — otherwise the whole list greys out.
  assert.ok(!('unavailable' in byId['ch-1105']));
});

test('/manga/chapters answers 200 with a reason when no provider matched', async () => {
  const { res, body } = await get('/manga/chapters/404?lang=pt-br');
  assert.equal(res.status, 200);
  assert.equal(body.provider, null);
  assert.equal(body.matchConfidence, null);
  assert.deepEqual(body.chapters, []);
  // The contract: a null provider ALWAYS carries a reason, and the reason is the payload.
  assert.equal(typeof body.reason, 'string');
  assert.match(body.reason, /serves language 'pt-br'/);
});

test('/manga/chapters forwards a known ?provider= and 400s an unknown one', async () => {
  const ok = await get('/manga/chapters/30013?provider=slowscans'); // case-insensitive, canonicalised
  assert.equal(ok.res.status, 200);
  assert.equal(ok.body.provider, 'SlowScans', 'the preferred provider never reached the aggregator');

  // Divergence from /watch (502): a typo is a client error, and the aggregator would otherwise
  // SILENTLY ignore it and answer with a different provider's chapters.
  const bad = await get('/manga/chapters/30013?provider=MangaDx');
  assert.equal(bad.res.status, 400);
  assert.match(bad.body.error, /unknown provider 'MangaDx'/);
  assert.ok(bad.body.providers.includes('FakeDex'), 'the 400 does not name the valid providers');
});

test('/manga/chapters maps an upstream throw to 502 and a hang to 504', async () => {
  const bad = await get('/manga/chapters/999');
  assert.equal(bad.res.status, 502);
  assert.match(bad.body.error, /manga chapters upstream failed/);
  const hung = await get('/manga/chapters/777');
  assert.equal(hung.res.status, 504);
  assert.match(hung.body.error, /manga chapters timed out/);
});

// ------------------------------------------------------------------ /manga/read

test('/manga/read returns pages whose img points back at THIS origin with the ref baked in', async () => {
  const { res, body } = await get('/manga/read?provider=SlowScans&chapterId=ch-1');
  assert.equal(res.status, 200);
  assert.equal(body.provider, 'SlowScans');
  assert.equal(body.chapterId, 'ch-1');
  assert.equal(body.pages.length, 2);
  const p = body.pages[0];
  assert.equal(p.rawImg, 'https://cdn.slow.example/ch/1/1.jpg');
  // Same-origin proxy link, derived from the request (PUBLIC_URL is unset in this harness).
  assert.ok(p.img.startsWith(`${base}/manga/image?url=`), `img is not a same-origin link: ${p.img}`);
  const u = new URL(p.img);
  assert.equal(u.searchParams.get('url'), p.rawImg);
  // The Referer travels IN THE LINK because an <img src> cannot carry a header.
  assert.equal(u.searchParams.get('ref'), 'https://slow.example/');
  assert.deepEqual(body.headers, { Referer: 'https://slow.example/' });
});

test('/manga/read derives Cache-Control from the provider policy, not a constant', async () => {
  // MangaDex-shaped: a per-request host that dies in ~15 minutes.
  const short = await fetch(`${base}/manga/read?provider=FakeDex&chapterId=ch-1`);
  await short.arrayBuffer();
  assert.equal(short.headers.get('cache-control'), 'public, max-age=600');

  // Scanlation-CDN-shaped: content-addressed, a year, immutable. If the header were hardcoded these
  // two could not differ.
  const long = await fetch(`${base}/manga/read?provider=SlowScans&chapterId=ch-1`);
  await long.arrayBuffer();
  assert.equal(long.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.notEqual(short.headers.get('cache-control'), long.headers.get('cache-control'));
});

test('/manga/read carries the policy in the body too, so a client sees the reason', async () => {
  const { body } = await get('/manga/read?provider=FakeDex&chapterId=ch-1');
  assert.equal(body.cache.ttlSeconds, 600);
  assert.equal(body.cache.immutable, false);
  assert.match(body.cache.note, /15 min/);
});

test('/manga/read refuses to invent a cache policy when the provider states none', async () => {
  const res = await fetch(`${base}/manga/read?provider=NoPolicy&chapterId=ch-1`);
  await res.arrayBuffer();
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('/manga/read forwards lang to the aggregator', async () => {
  const { body } = await get('/manga/read?provider=FakeDex&chapterId=ch-1&lang=pt-br');
  assert.equal(body.echoLang, 'pt-br');
});

test('/manga/read 400s an unknown provider and names the valid ones', async () => {
  const { res, body } = await get('/manga/read?provider=__nope__&chapterId=ch-1');
  assert.equal(res.status, 400);
  assert.match(body.error, /unknown provider '__nope__'/);
  assert.deepEqual(body.providers, ['FakeDex', 'SlowScans', 'NoPolicy', 'HangScans', 'FetchScans']);
});

test('/manga/read maps an upstream throw to 502 and a hang to 504', async () => {
  const bad = await get('/manga/read?provider=FakeDex&chapterId=boom');
  assert.equal(bad.res.status, 502);
  assert.match(bad.body.error, /manga read upstream failed: chapter fetch exploded/);
  // The one that matters operationally: MangaHere fetches one page per HTTP request, serially.
  const hung = await get('/manga/read?provider=HangScans&chapterId=ch-1');
  assert.equal(hung.res.status, 504);
  assert.match(hung.body.error, /manga read timed out: .*exceeded 400ms/);
});

// The SSRF guard now stands in front of a handler that WOULD have answered 200 — which is a
// stronger test than the 501-era one, where a rejection and a stub were both "not a fetch".
test('/manga/read still rejects a private-range chapterId before the handler runs', async () => {
  for (const id of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:9/',
    'http://10.0.0.5/internal',
    'http://[::1]/',
    'http://localhost:9/',
  ]) {
    const res = await fetch(`${base}/manga/read?provider=FakeDex&chapterId=${encodeURIComponent(id)}`);
    const body = await res.json();
    assert.equal(res.status, 400, `${id} → ${res.status}`);
    assert.match(body.error, /'chapterId' rejected/, id);
    assert.ok(!('pages' in body), `${id} reached the aggregator`);
  }
});

// The decisive one. 'FetchScans' in the harness FETCHES a URL-shaped chapterId, which is exactly
// what several real providers do — so this is a blind-SSRF probe with a live target behind it, not
// a status-code assertion. Remove the guard and the canary is hit and its body is returned.
test('/manga/read never lets a URL-shaped chapterId reach an internal service', async () => {
  const before = canaryHits;
  const res = await fetch(`${base}/manga/read?provider=FetchScans&chapterId=${encodeURIComponent(canaryUrl)}`);
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /'chapterId' rejected/);
  assert.ok(!text.includes('SECRET-CANARY-BODY'), 'internal response body leaked through /manga/read');
  assert.equal(canaryHits, before, 'chapterId reached the internal service');
});

// A repeated param arrives as an ARRAY, which a `typeof x === 'string'` guard skips and a later
// String() re-flattens into something that still starts with 'http'. Same live canary behind it.
test('/manga/read refuses a repeated chapterId rather than letting an array skip the guard', async () => {
  const before = canaryHits;
  const res = await fetch(
    `${base}/manga/read?provider=FetchScans&chapterId=${encodeURIComponent(canaryUrl)}&chapterId=x`
  );
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /must each be given exactly once/);
  assert.ok(!text.includes('SECRET-CANARY-BODY'));
  assert.equal(canaryHits, before, 'an array-valued chapterId reached the internal service');
});

test('/manga/read leaves a public URL-shaped chapterId alone', async () => {
  const { res, body } = await get(
    `/manga/read?provider=FakeDex&chapterId=${encodeURIComponent('https://1.1.1.1/ch/1')}`
  );
  assert.equal(res.status, 200);
  assert.equal(body.chapterId, 'https://1.1.1.1/ch/1');
});

// ------------------------------------------------------------------ the pieces, in process

test('cacheControlFor maps every policy shape the registry can produce', () => {
  assert.equal(cacheControlFor({ ttlSeconds: 600, immutable: false }), 'public, max-age=600');
  assert.equal(cacheControlFor({ ttlSeconds: 31536000, immutable: true }), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor({ ttlSeconds: 0, immutable: false }), 'public, max-age=0');
  // Unknown expiry is not a licence to cache: a wrong TTL serves dead image URLs with no recovery.
  assert.equal(cacheControlFor(undefined), 'no-store');
  assert.equal(cacheControlFor({}), 'no-store');
  assert.equal(cacheControlFor({ ttlSeconds: -1 }), 'no-store');
  assert.equal(cacheControlFor({ ttlSeconds: 'soon' }), 'no-store');
});

test('mangaImageProxy encodes both url and ref, and omits ref when there is none', () => {
  const img = mangaImageProxy('https://cdn.example/a b.jpg?x=1&y=2', 'https://ref.example/');
  const u = new URL(img, 'http://h');
  assert.equal(u.pathname, '/manga/image');
  assert.equal(u.searchParams.get('url'), 'https://cdn.example/a b.jpg?x=1&y=2');
  assert.equal(u.searchParams.get('ref'), 'https://ref.example/');
  assert.ok(!mangaImageProxy('https://cdn.example/a.jpg').includes('ref='));
});

// The seam itself, against the REAL aggregator. A fake aggregator cannot prove this: the thing
// being tested is that MangaAggregator calls the injected imageProxy for every page, with the
// PER-PAGE Referer — which is the only place that Referer is ever visible (the returned page object
// does not carry it).
test('the real MangaAggregator mints pages[].img through the injected imageProxy', async () => {
  const { MangaAggregator } = (await import('../../consumet/dist/index.js')).default;
  const parser = {
    name: 'SeamProbe',
    search: async () => ({ results: [] }),
    fetchMangaInfo: async () => ({ chapters: [] }),
    fetchChapterPages: async () => [
      // Page 1 states its own Referer (MangaHere does this); page 2 does not and must fall back to
      // the registry's.
      { page: 7, img: 'https://cdn.probe.example/1.jpg', headerForImage: { Referer: 'https://per-page.example/' } },
      { page: 8, img: 'https://cdn.probe.example/2.jpg' },
      { page: 9, img: undefined }, // dropped by the aggregator, never proxied
    ],
  };
  // Built the SAME way server.mjs builds the deployed one, so the seam under test is the installed
  // one and not a second copy wired by hand.
  const agg = createMangaAggregator(MangaAggregator, {
    providers: [{ parser, traits: { imageHeaders: { Referer: 'https://registry.example/' } } }],
  });
  const out = await agg.getPages('SeamProbe', 'ch-1');
  assert.equal(out.pages.length, 2, 'the page with no image url was not dropped');
  // Root-relative outside a request and with no PUBLIC_URL: still a correct same-origin link, and
  // honest that nothing told us the origin. Inside a request the route supplies it (tested above).
  assert.equal(
    out.pages[0].img,
    `/manga/image?url=${encodeURIComponent('https://cdn.probe.example/1.jpg')}&ref=${encodeURIComponent('https://per-page.example/')}`
  );
  assert.equal(
    out.pages[1].img,
    `/manga/image?url=${encodeURIComponent('https://cdn.probe.example/2.jpg')}&ref=${encodeURIComponent('https://registry.example/')}`
  );
  assert.equal(out.pages[0].page, 1, 'page numbers are not re-derived from array order');
  assert.equal(out.pages[0].providerPage, 7);
});

test('createMangaAggregator installs the image seam, and a caller cannot forget it', () => {
  let seen;
  class Ctor {
    constructor(opts) {
      seen = opts;
    }
  }
  createMangaAggregator(Ctor);
  assert.equal(seen.imageProxy, mangaImageProxy, 'the deployed aggregator would emit unproxied img urls');
  // Extra options are merged, but the seam is the default and callers pass none.
  createMangaAggregator(Ctor, { providers: [] });
  assert.equal(seen.imageProxy, mangaImageProxy);
  assert.deepEqual(seen.providers, []);
});

// The claim from the brief that had to be checked rather than assumed: the rate gate really does
// attach to each provider's own axios client, so it covers the requests the aggregator never makes
// itself — MangaHere's one-request-per-page storm in particular.
test('every registered manga provider is actually rate-gated', async () => {
  const { MangaAggregator } = (await import('../../consumet/dist/index.js')).default;
  const agg = new MangaAggregator();
  const described = agg.describeProviders();
  assert.ok(described.length >= 6, `expected the six-provider working set, got ${described.length}`);
  for (const p of described) {
    assert.equal(p.rateGated, true, `${p.name} is NOT rate-gated — its upstream calls are unthrottled`);
    assert.ok(p.requestsPerSecond > 0, `${p.name} has no rate`);
  }
  // A provider registered without a client (the seam probe above) is honestly reported as un-gated
  // rather than silently assumed throttled.
  const bare = new MangaAggregator({ providers: [{ parser: { name: 'NoClient' } }] });
  assert.equal(bare.describeProviders()[0].rateGated, false);
});
