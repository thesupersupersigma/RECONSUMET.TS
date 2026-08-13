// Black-box tests: boot the real server and attack it over HTTP.
//
// The unit suite (ssrf-guard.test.mjs) proves the guard's logic; this one proves the guard is
// actually WIRED INTO the routes — that /proxy rejects before it fetches anything. There is no live
// deployment to test against (the VM was lost), so this spawns the real `src/server.mjs` on a free
// loopback port and talks to it exactly the way an attacker would.
//
// Everything here is offline: the rejected requests never reach an upstream, and the canary server
// that proves that is local.
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
/** loopback HTTP server used as the SSRF target: it must never be reached */
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

const proxy = url => fetch(`${base}/proxy?url=${encodeURIComponent(url)}`);

// ---------------------------------------------------------------- H1: /proxy

test('/proxy rejects the cloud metadata endpoint', async () => {
  const res = await proxy('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /blocked \(private\/loopback\/metadata\) range/);
});

test('/proxy rejects loopback, private, CGNAT and IPv6-internal targets', async () => {
  for (const url of [
    'http://127.0.0.1:4000/',
    'http://10.0.0.5/internal',
    'http://192.168.1.1/router',
    'http://172.16.0.1/',
    'http://100.64.0.1/',
    'http://[::1]:4000/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'https://[::ffff:169.254.169.254]/',
  ]) {
    const res = await proxy(url);
    assert.equal(res.status, 400, `${url} → ${res.status}`);
    assert.match((await res.json()).error, /rejected/, url);
  }
});

test('/proxy rejects non-http schemes and malformed urls', async () => {
  for (const url of ['file:///etc/passwd', 'gopher://127.0.0.1:11211/_stats', 'not a url']) {
    const res = await proxy(url);
    assert.equal(res.status, 400, `${url} → ${res.status}`);
  }
  const missing = await fetch(`${base}/proxy`);
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /missing 'url'/);
});

test('/proxy rejects non-dotted encodings of a loopback address', async () => {
  for (const url of ['http://2130706433/', 'http://0177.0.0.1/', 'http://localhost:4000/']) {
    const res = await proxy(url);
    assert.equal(res.status, 400, `${url} → ${res.status}`);
  }
});

// The decisive one: prove the request is refused BEFORE any socket is opened to the target.
test('/proxy never actually contacts a blocked target', async () => {
  const before = canaryHits;
  const res = await proxy(canaryUrl);
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.ok(!body.includes('SECRET-CANARY-BODY'), 'internal response body leaked through /proxy');
  assert.equal(canaryHits, before, 'the guard let a request through to the internal service');
});

// ---------------------------------------------------------------- M2: /watch episodeId
//
// Providers resolve an episodeId that starts with "http" as a full URL and fetch it directly
// (gogoanime.ts:191, anizone.ts:238, anineko.ts:254, animenosub.ts:238 — all `id.startsWith('http')
// ? id : base+id`), so episodeId is a second, blind SSRF vector. `__nope__` is a deliberately
// unknown provider: the aggregator rejects it before any network call, so these stay offline and
// let us tell "rejected by the guard" (400) apart from "reached the aggregator" (502).

const watch = episodeId =>
  fetch(`${base}/watch?provider=__nope__&episodeId=${encodeURIComponent(episodeId)}`);

test('/watch rejects a URL-shaped episodeId pointing at metadata or internal hosts', async () => {
  for (const id of [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:4000/',
    'http://10.0.0.5/internal',
    'http://[::1]/',
    'https://[::ffff:169.254.169.254]/',
    'http://localhost:4000/',
  ]) {
    const res = await watch(id);
    assert.equal(res.status, 400, `${id} → ${res.status}`);
    assert.match((await res.json()).error, /'episodeId' rejected/, id);
  }
});

test('/watch never contacts an internal target named by episodeId (blind SSRF)', async () => {
  const before = canaryHits;
  const res = await watch(canaryUrl);
  assert.equal(res.status, 400);
  assert.equal(canaryHits, before, 'episodeId reached the internal service');
});

test('/watch leaves ordinary slug episodeIds and public URLs alone', async () => {
  // Not rejected by the guard — they reach the aggregator, which 502s on the unknown provider.
  for (const id of ['naruto-episode-1', 'one-piece/1a2b3c4d-5e6f', 'https://1.1.1.1/legit.m3u8']) {
    const res = await watch(id);
    assert.equal(res.status, 502, `${id} → ${res.status}`);
    assert.doesNotMatch((await res.json()).error, /episodeId' rejected/, id);
  }
});
