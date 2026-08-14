// Black-box tests for the manga surface, in the same style as server-ssrf.test.mjs: spawn the real
// src/server.mjs on a free loopback port and talk to it over HTTP.
//
// Two things are being proved, and only two — because only two are true yet:
//   1. The route SHAPE is real. Every manga route exists, validates its params (400), and otherwise
//      answers 501 with a machine-readable body. Nothing is falsely wired to a provider.
//   2. The SSRF guard is ALREADY WIRED on the two URL-taking manga inputs (/manga/image?url= and
//      /manga/read?chapterId=http...). This is the part that must never regress: it is checked with
//      a local canary server that must never be contacted, exactly like the /proxy tests.
//
// Fully offline. Every request here is rejected or 501'd before any upstream is reached.
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

// ------------------------------------------------------------------ shape: 501, not 404

test('every manga route is mounted and answers 501, never 404', async () => {
  const routes = [
    '/manga/search?q=chainsaw%20man',
    '/manga/info/105778',
    '/manga/chapters/105778',
    '/manga/chapters/105778?provider=MangaDex&lang=pt-br',
    '/manga/read?provider=MangaDex&chapterId=abc-123',
    '/manga/image?url=https%3A%2F%2F1.1.1.1%2Fpage-1.png',
  ];
  for (const r of routes) {
    const res = await fetch(`${base}${r}`);
    assert.equal(res.status, 501, `${r} → ${res.status}`);
    const body = await res.json();
    assert.match(body.error, /not wired yet/, r);
    assert.ok(typeof body.route === 'string' && body.route.startsWith('GET /manga/'), `${r} lacks a route label`);
  }
});

test('the / route advertises the manga surface', async () => {
  const body = await (await fetch(`${base}/`)).json();
  assert.ok(body.routes.manga, 'manga routes missing from the root listing');
  for (const k of ['search', 'info', 'chapters', 'read', 'image']) {
    assert.ok(body.routes.manga[k], `root listing missing manga.${k}`);
  }
  // the anime surface must be untouched
  for (const k of ['search', 'info', 'episodes', 'watch', 'proxy']) {
    assert.ok(body.routes[k], `anime route listing lost ${k}`);
  }
});

// ------------------------------------------------------------------ param validation (real, not stubbed)

test('manga routes reject bad params with 400 before reaching the 501', async () => {
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
  // Not rejected by the guard — they fall through to the 501 stub, which is how we tell
  // "the guard fired" (400) apart from "the guard correctly stood aside" (501).
  for (const id of ['723-10001000/chainsaw-man-chapter-1', 'a77742b1-befd-49a4-bff5-1ad4e6b0ef7b', 'https://1.1.1.1/ch/1']) {
    const res = await read(id);
    assert.equal(res.status, 501, `${id} → ${res.status}`);
    assert.doesNotMatch((await res.json()).error, /chapterId' rejected/, id);
  }
});
