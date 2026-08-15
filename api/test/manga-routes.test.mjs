// Black-box tests for the manga surface, in the same style as server-ssrf.test.mjs: spawn the real
// src/server.mjs on a free loopback port and talk to it over HTTP.
//
// This file proves what must be true of the DEPLOYED server, with its REAL aggregator:
//   1. Every manga route exists and validates its params (400) — including the four that are now
//      wired, which are reachable here only up to the point where they would touch a provider.
//   2. No route answers 501 any more — the manga surface is fully wired. /manga/image's byte path
//      cannot be exercised here (it would need a real public upstream), so it is proved in
//      manga-image.test.mjs against the same plugin with a faked socket layer; what IS proved here
//      is that the deployed route is the real handler and not the old stub.
//   3. The real MangaAggregator is actually installed (an unknown ?provider= comes back naming the
//      real six-provider registry — MangaDex et al, not a fake).
//   4. The SSRF guard is WIRED on the two URL-taking manga inputs (/manga/image?url= and
//      /manga/read?chapterId=http...). This is the part that must never regress: it is checked with
//      a local canary server that must never be contacted, exactly like the /proxy tests.
//
// The WIRING of the four live routes — envelopes, matchConfidence, reason, Cache-Control, 502/504 —
// is proved in manga-wired.test.mjs, which mounts the same plugin with a fake aggregator. It has to
// be a separate server: exercising a wired route here would hit AniList and four scrapers.
//
// Fully offline. Every request here is rejected, 501'd, or answered from the registry before any
// upstream is reached.
//
// Run: cd api && node --test 'test/**/*.test.mjs'

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');

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
let serverLog = '';
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
  canaryUrl = `http://127.0.0.1:${canaryPort}/secret.png`;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => (serverLog += d));
  child.stderr.on('data', d => (serverLog += d));

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${serverLog}`);
    try {
      const r = await fetch(`${base}/`);
      if (r.ok) {
        await r.arrayBuffer();
        break;
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${serverLog}`);
    await new Promise(r => setTimeout(r, 150));
  }
}, { timeout: 60_000 });

after(async () => {
  child?.kill('SIGKILL');
  await new Promise(r => canary?.close(r));
});

// ------------------------------------------------------------------ shape: mounted, not 404

// Each of these reaches the handler and is answered WITHOUT any upstream call, so the route is
// proved mounted (never 404, never Fastify's own 400) while staying offline. A 501 in this list
// would mean the wiring was reverted.
test('all five manga routes are mounted and none answers 501', async () => {
  const cases = [
    ['/manga/search', 400, /missing or empty 'q'/],
    ['/manga/info/abc', 400, /anilistId must be numeric/],
    ['/manga/chapters/abc', 400, /anilistId must be numeric/],
    ['/manga/chapters/105778?provider=__nope__', 400, /unknown provider/],
    ['/manga/read?provider=__nope__&chapterId=abc-123', 400, /unknown provider/],
    // A repeated ?url= is answered by the multiplicity guard, which exists only in the wired
    // route: the old 501 stub stringified the array into 'https://1.1.1.1/p.png,x', let it past
    // assertUrlSafe (host 1.1.1.1, public) and answered 501. So this single case is an offline,
    // network-free discriminator between the stub and the real handler on the DEPLOYED server —
    // the byte-serving path itself is proved in manga-image.test.mjs.
    [
      '/manga/image?url=https%3A%2F%2F1.1.1.1%2Fp.png&url=x',
      400,
      /'url' and 'ref' must each be given at most once/,
    ],
  ];
  for (const [r, status, re] of cases) {
    const res = await fetch(`${base}${r}`);
    assert.equal(res.status, status, `${r} → ${res.status}`);
    const body = await res.json();
    assert.match(body.error, re, r);
    assert.doesNotMatch(body.error, /not wired yet/, `${r} is still stubbed`);
  }
});

// The proof that the REAL aggregator is what got wired in — a fake could not name these.
test('the real six-provider manga registry is installed', async () => {
  const res = await fetch(`${base}/manga/read?provider=__nope__&chapterId=abc-123`);
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(body.providers), 'the 400 does not name the registry');
  for (const p of ['MangaDex', 'MangaHere', 'MangaPill']) {
    assert.ok(body.providers.includes(p), `manga registry missing ${p}: ${body.providers.join(',')}`);
  }
  assert.ok(body.providers.length >= 6, `expected the six-provider working set, got ${body.providers.length}`);
});

test('the / route advertises the manga surface', async () => {
  const body = await (await fetch(`${base}/`)).json();
  assert.ok(body.routes.manga, 'manga routes missing from the root listing');
  for (const k of ['search', 'info', 'chapters', 'read', 'image']) {
    assert.ok(body.routes.manga[k], `root listing missing manga.${k}`);
  }
  // Manga providers are a DIFFERENT set from the anime ones, and are also the valid ?provider=
  // values, so the root route lists both.
  assert.ok(Array.isArray(body.mangaProviders) && body.mangaProviders.includes('MangaDex'));
  assert.ok(!body.providers.includes('MangaDex'), 'the anime provider list absorbed a manga provider');
  // the anime surface must be untouched
  for (const k of ['search', 'info', 'episodes', 'watch', 'proxy']) {
    assert.ok(body.routes[k], `anime route listing lost ${k}`);
  }
});

// ------------------------------------------------------------------ param validation (real, not stubbed)

test('manga routes reject bad params with 400 before reaching a provider', async () => {
  const cases = [
    ['/manga/search', /missing or empty 'q'/],
    ['/manga/search?q=%20%20', /missing or empty 'q'/],
    // NB: page=-1, not page=0. `Number(q.page) || 1` makes 0 falsy → page 1, so ?page=0 is silently
    // coerced rather than rejected. That is a pre-existing quirk of the anime /search route which
    // this route mirrors ON PURPOSE; asserting it here pins the shared behaviour.
    ['/manga/search?q=x&page=-1', /'page' must be >= 1/],
    ['/manga/info/not-a-number', /anilistId must be numeric/],
    ['/manga/chapters/abc', /anilistId must be numeric/],
    ['/manga/chapters/105778?lang=english!!', /'lang' must be a language tag/],
    ['/manga/read?provider=MangaDex', /missing 'provider' and\/or 'chapterId'/],
    ['/manga/read?chapterId=abc', /missing 'provider' and\/or 'chapterId'/],
    ['/manga/read?provider=x&chapterId=y&lang=..', /'lang' must be a language tag/],
    ['/manga/image', /missing 'url'/],
  ];
  for (const [route, re] of cases) {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 400, `${route} → ${res.status}`);
    assert.match((await res.json()).error, re, route);
  }
});

// ------------------------------------------------------------------ SSRF: the part that is NOT stubbed

const image = url => fetch(`${base}/manga/image?url=${encodeURIComponent(url)}`);

test('/manga/image rejects metadata, loopback, private and IPv6-internal targets', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:4000/page.png',
    'http://10.0.0.5/internal.png',
    'http://192.168.1.1/router.png',
    'http://172.16.0.1/x.png',
    'http://100.64.0.1/x.png',
    'http://[::1]:4000/x.png',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'https://[::ffff:169.254.169.254]/x.png',
    'http://2130706433/x.png',
    'http://0177.0.0.1/x.png',
    'http://localhost:4000/x.png',
  ]) {
    const res = await image(url);
    assert.equal(res.status, 400, `${url} → ${res.status}`);
    assert.match((await res.json()).error, /'url' rejected/, url);
  }
});

test('/manga/image rejects non-http schemes and malformed urls', async () => {
  for (const url of ['file:///etc/passwd', 'gopher://127.0.0.1:11211/_stats', 'not a url']) {
    const res = await image(url);
    assert.equal(res.status, 400, `${url} → ${res.status}`);
  }
});

// The decisive one: the guard must refuse BEFORE a socket is opened to the target.
test('/manga/image never contacts a blocked target', async () => {
  const before = canaryHits;
  const res = await image(canaryUrl);
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.ok(!body.includes('SECRET-CANARY-BODY'), 'internal response body leaked through /manga/image');
  assert.equal(canaryHits, before, 'the guard let a request through to the internal service');
});

test("/manga/image validates 'ref' as an http url without ever fetching it", async () => {
  const before = canaryHits;
  const res = await fetch(
    `${base}/manga/image?url=${encodeURIComponent('https://1.1.1.1/p.png')}&ref=${encodeURIComponent('javascript:alert(1)')}`
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /'ref' must be an http\(s\) url/);
  assert.equal(canaryHits, before);
});

// /manga/read?chapterId= mirrors /watch?episodeId= — manga providers resolve an id that starts with
// 'http' as a URL the same way the anime ones do, so it is guarded at the same boundary.
const read = chapterId =>
  fetch(`${base}/manga/read?provider=__nope__&chapterId=${encodeURIComponent(chapterId)}`);

test('/manga/read rejects a URL-shaped chapterId pointing at metadata or internal hosts', async () => {
  for (const id of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:4000/',
    'http://10.0.0.5/internal',
    'http://[::1]/',
    'https://[::ffff:169.254.169.254]/',
    'http://localhost:4000/',
  ]) {
    const res = await read(id);
    assert.equal(res.status, 400, `${id} → ${res.status}`);
    assert.match((await res.json()).error, /'chapterId' rejected/, id);
  }
});

test('/manga/read never contacts an internal target named by chapterId (blind SSRF)', async () => {
  const before = canaryHits;
  const res = await read(canaryUrl);
  assert.equal(res.status, 400);
  assert.equal(canaryHits, before, 'chapterId reached the internal service');
});

test('/manga/read leaves ordinary slug chapterIds and public URLs alone', async () => {
  // Not rejected by the guard — they fall through PAST it to the provider-name check, which is how
  // we tell "the guard fired" from "the guard correctly stood aside". Both answer 400 now (the
  // provider here is deliberately bogus so nothing upstream is contacted), so the discriminator is
  // the message, not the status.
  for (const id of ['723-10001000/chainsaw-man-chapter-1', 'a77742b1-befd-49a4-bff5-1ad4e6b0ef7b', 'https://1.1.1.1/ch/1']) {
    const res = await read(id);
    assert.equal(res.status, 400, `${id} → ${res.status}`);
    const body = await res.json();
    assert.doesNotMatch(body.error, /chapterId' rejected/, id);
    assert.match(body.error, /unknown provider/, id);
  }
});
