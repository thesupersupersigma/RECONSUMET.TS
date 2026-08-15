// Black-box tests for the REPEATED-QUERY-PARAM class of bypass.
//
// Fastify's querystring parser turns `?x=a&x=b` into an ARRAY. Every guard in server.mjs is written
// as a string test — `typeof v === 'string' && v.startsWith(...)`, a regex, `Number(v)` — so an
// array either skips the guard entirely or is silently stringified with a comma past it. The
// headline instance was /watch's SSRF check:
//
//     if (typeof episodeId === 'string' && episodeId.startsWith('http')) await assertUrlSafe(...)
//
// An array fails `typeof === 'string'`, so assertUrlSafe was NEVER CALLED and the value went
// straight to the provider — several of which (gogoanime, anizone, anineko, animenosub, senshi)
// fetch an episodeId that starts with "http" as a full URL. `?episodeId=http://169.254.169.254/x&
// episodeId=` even stringifies to a valid URL ("http://169.254.169.254/x,"), so anything
// downstream that interpolates instead of calling .startsWith() would fetch it.
//
// These tests assert the guard now answers 400 *at the boundary*. That is what makes them
// mutation-sensitive: delete `isSingle` from server.mjs and the array no longer stops here — it
// reaches the aggregator/SSRF guard and the status/message change (502, or a different 400).
// Verified by doing exactly that; see the item report.
//
// Fully offline. Every request either 400s before a socket is opened, or names the local canary —
// which is asserted to receive nothing.
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
/** loopback HTTP server serving REAL bytes: a guard failure leaks content, not just a status */
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
  canaryUrl = `http://127.0.0.1:${canaryPort}/secret`;

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

const q = s => encodeURIComponent(s);
const body = async res => {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: {} };
  }
};

// ------------------------------------------------------------------ /watch (the SSRF bypass)

test('/watch rejects a REPEATED episodeId instead of skipping the SSRF guard', async () => {
  // `__nope__` is not a real provider: if the array got past the guard the aggregator would answer
  // 502. A 400 with the multiplicity message is the only way this passes.
  const before = canaryHits;
  for (const second of ['', 'x', canaryUrl]) {
    const res = await fetch(`${base}/watch?provider=__nope__&episodeId=${q(canaryUrl)}&episodeId=${q(second)}`);
    assert.equal(res.status, 400, `second=${second} → ${res.status}`);
    const { text, json } = await body(res);
    assert.match(json.error, /must each be given at most once/, text);
    assert.ok(!text.includes('SECRET-CANARY-BODY'), 'canary body leaked through /watch');
  }
  assert.equal(canaryHits, before, 'a repeated episodeId reached the internal service');
});

test('/watch rejects a REPEATED provider before it reaches the aggregator', async () => {
  const res = await fetch(`${base}/watch?provider=Gogoanime&provider=__nope__&episodeId=naruto-episode-1`);
  assert.equal(res.status, 400);
  const { text, json } = await body(res);
  assert.match(json.error, /must each be given at most once/, text);
  // the old behaviour: an array reached agg.getSourcesAll and died on providerName.toLowerCase()
  assert.doesNotMatch(text, /toLowerCase/, 'internal TypeError leaked to the client');
});

test('/watch still accepts ordinary single-valued requests', async () => {
  // unchanged path: a slug reaches the aggregator, which 502s on the unknown provider…
  const ok = await fetch(`${base}/watch?provider=__nope__&episodeId=naruto-episode-1`);
  assert.equal(ok.status, 502);
  assert.doesNotMatch((await body(ok)).text, /at most once/);
  // …and a single URL-shaped episodeId is still rejected by the SSRF guard, with ITS message.
  const blocked = await fetch(`${base}/watch?provider=__nope__&episodeId=${q(canaryUrl)}`);
  assert.equal(blocked.status, 400);
  assert.match((await body(blocked)).json.error, /'episodeId' rejected/);
});

// ------------------------------------------------------------------ /episodes

test('/episodes rejects a REPEATED provider', async () => {
  const res = await fetch(`${base}/episodes/1?provider=Gogoanime&provider=__nope__`);
  assert.equal(res.status, 400);
  const { text, json } = await body(res);
  assert.match(json.error, /'provider' must be given at most once/, text);
  assert.doesNotMatch(text, /toLowerCase/, 'internal TypeError leaked to the client');
});

// ------------------------------------------------------------------ /proxy (every param)

test('/proxy rejects a repeated value for every one of its params', async () => {
  const before = canaryHits;
  const u = q(canaryUrl);
  for (const [name, qs] of [
    ['url', `url=${u}&url=`],
    ['url(2 targets)', `url=${u}&url=${q('http://1.1.1.1/')}`],
    ['ref', `url=${u}&ref=http://a/&ref=http://b/`],
    ['pk', `url=${u}&pk=a&pk=b`],
    ['km', `url=${u}&km=a&km=b`],
    ['org', `url=${u}&org=http://a/&org=http://b/`],
    ['aud', `url=${u}&aud=eng&aud=jpn`],
  ]) {
    const res = await fetch(`${base}/proxy?${qs}`);
    assert.equal(res.status, 400, `${name} → ${res.status}`);
    const { text, json } = await body(res);
    assert.match(json.error, /must each be given at most once/, `${name}: ${text}`);
    assert.ok(!text.includes('SECRET-CANARY-BODY'), `${name}: canary body leaked through /proxy`);
  }
  assert.equal(canaryHits, before, 'a repeated /proxy param reached the internal service');
});

test('/proxy single-valued behaviour is unchanged', async () => {
  const missing = await fetch(`${base}/proxy`);
  assert.equal(missing.status, 400);
  assert.match((await body(missing)).json.error, /missing 'url'/);

  const blocked = await fetch(`${base}/proxy?url=${q(canaryUrl)}&ref=http://a/&pk=a&km=a&org=http://a/&aud=eng`);
  assert.equal(blocked.status, 400);
  assert.match((await body(blocked)).json.error, /'url' rejected/); // the SSRF guard, not the arity one
});

// ------------------------------------------------------------------ /search
//
// No fix needed here — both reads already fail CLOSED — but the property is asserted so a future
// refactor cannot quietly lose it. (`?page=` repetition is NOT covered: proving it defaults to 1
// requires a live AniList search, and this suite is offline.)

test('/search rejects a repeated q (fails closed, no upstream call)', async () => {
  const res = await fetch(`${base}/search?q=naruto&q=bleach`);
  assert.equal(res.status, 400);
  assert.match((await body(res)).json.error, /missing or empty 'q'/);
});

// ------------------------------------------------------------------ the whole-file invariant

test('nothing in this file ever reached the loopback canary', () => {
  assert.equal(canaryHits, 0, `the canary was contacted ${canaryHits}x — a guard let a request through`);
});
