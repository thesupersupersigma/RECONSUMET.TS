// A forged `Host` header must not be able to put a single byte into a URL this API hands out.
//
// THE BUG. Both route modules built links as `process.env.PUBLIC_URL || `${req.protocol}://${req
// .headers.host}``, so with PUBLIC_URL unset every generated URL echoed a client-supplied header.
// Reproduced against the real routes plugin before the fix:
//     Host: evil.attacker.example  ->  pages[].img = http://evil.attacker.example/manga/image?url=...
// The same helper feeds /watch's `sources[].url` and the HLS playlist rewrite, and /manga/read
// answers carry provider-chosen `Cache-Control` (a year, `immutable`, for content-addressed CDNs),
// so a cache keyed on URL and not Host spreads one attacker's forged links to everybody.
//
// WHAT IS ASSERTED, AND AT WHICH LAYER:
//   1. the resolver itself (unit) — the Host shapes that could smuggle an origin past a naive
//      comparison: ports, IPv6 brackets, userinfo, a path, case, arrays, X-Forwarded-Host
//   2. /manga/read over real HTTP (the route the bug was found on) against the real routes plugin,
//      in all three configurations: nothing set, PUBLIC_URL set, allowlist set
//   3. /watch over real HTTP against the REAL src/server.mjs — offline, because the base is now
//      resolved before the aggregator is called
//   4. the m3u8 rewrite at the /proxy playlist branch, by SOURCE INSPECTION, with the reason it
//      cannot be driven end-to-end spelled out at that test
//   5. startup: a malformed PUBLIC_URL must kill the process with the variable named, not listen
//
// Fully offline. Run: cd api && node --test 'test/**/*.test.mjs'

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PublicBaseError,
  createPublicBase,
  isLoopbackAddress,
  isLoopbackHostHeader,
  normaliseHostHeader,
  parsePublicBase,
  parsePublicBaseList,
  resolvePublicBaseEnv,
} from '../src/validators.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'fixtures', 'manga-fake-server.mjs');
const SERVER = path.join(HERE, '..', 'src', 'server.mjs');

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/**
 * A raw request, because `fetch` will not let a caller set `Host` — it is a forbidden header name
 * in the fetch spec, so the whole attack is invisible to the tool the rest of the suite uses.
 */
const rawGet = (port, pathname, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

/** Spawn a script on a free loopback port and wait for it to answer. Returns { port, child, log }. */
const boot = async (script, env, ready) => {
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => (log += d));
  child.stderr.on('data', d => (log += d));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      child.kill('SIGKILL');
      throw new Error(`${path.basename(script)} exited early (${child.exitCode}):\n${log}`);
    }
    try {
      const r = await rawGet(port, ready);
      if (r.status) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`${path.basename(script)} never came up:\n${log}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return { port, child, log: () => log };
};

// =================================================================================================
// 1. the resolver itself
// =================================================================================================

describe('createPublicBase', () => {
  const loopbackReq = (host, remote = '127.0.0.1') => ({ headers: { host }, socket: { remoteAddress: remote } });
  const pinned = parsePublicBase('https://api.example.test');

  test('a forged Host cannot influence the base when PUBLIC_URL is set', () => {
    const resolve = createPublicBase({ publicUrl: pinned });
    // Every one of these is a shape that has smuggled an origin past a naive host check somewhere:
    // a bare name, a port, an IPv6 literal, userinfo, a path, and a raw CRLF.
    for (const host of [
      'evil.attacker.example',
      'evil.attacker.example:8443',
      '[2001:db8::1]:9999',
      'api.example.test@evil.attacker.example',
      'api.example.test/../evil.attacker.example',
      'API.EXAMPLE.TEST',
      'evil.attacker.example\r\nX: y',
      '',
      undefined,
    ]) {
      assert.equal(resolve(loopbackReq(host)), 'https://api.example.test', `Host ${JSON.stringify(host)} moved the base`);
    }
  });

  test('a repeated Host header (an array) cannot influence the base either', () => {
    const resolve = createPublicBase({ publicUrl: pinned });
    assert.equal(resolve(loopbackReq(['api.example.test', 'evil.attacker.example'])), 'https://api.example.test');
  });

  test('X-Forwarded-Host and X-Forwarded-Proto are never read', () => {
    const resolve = createPublicBase({ publicUrl: pinned });
    const req = {
      headers: { host: 'api.example.test', 'x-forwarded-host': 'evil.attacker.example', 'x-forwarded-proto': 'gopher' },
      socket: { remoteAddress: '10.0.0.9' },
    };
    assert.equal(resolve(req), 'https://api.example.test');
  });

  test('a trailing slash and a path prefix are both handled, and neither doubles a slash', () => {
    assert.equal(createPublicBase({ publicUrl: parsePublicBase('https://a.test/') })(loopbackReq('x')), 'https://a.test');
    assert.equal(createPublicBase({ publicUrl: parsePublicBase('https://a.test/api/') })(loopbackReq('x')), 'https://a.test/api');
  });

  describe('the allowlist SELECTS a configured origin; it never builds one', () => {
    const allowedOrigins = parsePublicBaseList('https://a.test, https://b.test:8443, http://c.test');
    const resolve = createPublicBase({ publicUrl: pinned, allowedOrigins });

    test('a matching Host picks that origin', () => {
      assert.equal(resolve(loopbackReq('a.test')), 'https://a.test');
      assert.equal(resolve(loopbackReq('b.test:8443')), 'https://b.test:8443');
      assert.equal(resolve(loopbackReq('c.test')), 'http://c.test');
    });

    test('the scheme comes from the CONFIG, not the request — so a Host cannot downgrade it', () => {
      // `a.test` is configured as https. There is no input that makes this emit http://a.test.
      assert.equal(resolve(loopbackReq('a.test')), 'https://a.test');
      assert.equal(resolve(loopbackReq('a.test:443')), 'https://a.test', 'the https default port must match');
      // ...and c.test is configured as http, so its https default port must NOT match it.
      assert.equal(resolve(loopbackReq('c.test:443')), 'https://api.example.test', 'c.test:443 matched an http origin');
    });

    test('Host matching is case-insensitive but nothing else-insensitive', () => {
      assert.equal(resolve(loopbackReq('A.TEST')), 'https://a.test');
      for (const near of ['a.test.evil.example', 'evila.test', 'a.test:80', 'a.test/', 'a.test@evil.example', ' a.test']) {
        assert.equal(resolve(loopbackReq(near)), 'https://api.example.test', `${JSON.stringify(near)} matched a.test`);
      }
    });

    test('an unmatched Host falls back to PUBLIC_URL, and to a loud throw when there is none', () => {
      assert.equal(resolve(loopbackReq('nope.test')), 'https://api.example.test');
      const noDefault = createPublicBase({ allowedOrigins });
      assert.throws(() => noDefault(loopbackReq('nope.test')), PublicBaseError);
      assert.throws(() => noDefault(loopbackReq('nope.test')), /Set PUBLIC_URL to this deployment's public origin/);
      // and not by echoing the caller's Host back into a response body
      assert.throws(() => noDefault(loopbackReq('nope.test')), e => !/nope\.test/.test(e.message));
    });
  });

  describe('the loopback dev fallback needs BOTH halves', () => {
    const resolve = createPublicBase({}); // nothing configured at all

    test('a loopback Host over a loopback socket works, so local dev needs no config', () => {
      assert.equal(resolve(loopbackReq('127.0.0.1:4000')), 'http://127.0.0.1:4000');
      assert.equal(resolve(loopbackReq('localhost:3000', '::ffff:127.0.0.1')), 'http://localhost:3000');
      assert.equal(resolve(loopbackReq('[::1]:3000', '::1')), 'http://[::1]:3000');
    });

    test('a loopback Host from a REMOTE peer does not — this is what makes it unreachable in prod', () => {
      // In the SETUP.md deployment the socket peer is Traefik on the private Docker network, and for
      // a directly-exposed process it is a public client. Neither is loopback, so no request that
      // arrives over the network can take this branch however it spells its Host.
      for (const remote of ['172.18.0.4', '10.0.0.9', '203.0.113.7', '::ffff:203.0.113.7', '2001:db8::5', '']) {
        assert.throws(() => resolve(loopbackReq('127.0.0.1:4000', remote)), PublicBaseError, `peer ${remote} was trusted`);
      }
      // ...and a request object with no socket at all (a direct library caller) is not local either.
      assert.throws(() => resolve({ headers: { host: '127.0.0.1:4000' } }), PublicBaseError);
    });

    test('a NON-loopback Host from a loopback peer does not either', () => {
      for (const host of ['evil.attacker.example', 'api.example.test', '10.0.0.9', '127.0.0.1.evil.example', '0.0.0.0']) {
        assert.throws(() => resolve(loopbackReq(host)), PublicBaseError, `Host ${host} was treated as local`);
      }
    });

    test('the throw names the variable to set', () => {
      assert.throws(() => resolve(loopbackReq('evil.attacker.example')), /Set PUBLIC_URL to this deployment's public origin/);
    });

    test('req.ip is deliberately NOT consulted — only the raw socket peer is', () => {
      // req.ip is trustProxy-derived and therefore XFF-influenced, i.e. exactly the input being
      // distrusted. A req carrying a loopback req.ip and a remote socket must still be refused.
      assert.throws(() => resolve({ headers: { host: '127.0.0.1:4000' }, ip: '127.0.0.1', socket: { remoteAddress: '203.0.113.7' } }), PublicBaseError);
    });
  });
});

describe('parsePublicBase / helpers', () => {
  test('unset or empty is null, not an error — that is the dev default', () => {
    for (const v of [undefined, null, '', '   ']) assert.equal(parsePublicBase(v), null);
    assert.deepEqual(parsePublicBaseList(''), []);
  });

  test('a malformed value throws with the variable name in the message', () => {
    for (const v of ['not-a-url', 'api.example.test', '//api.example.test', 'ftp://a.test', 'javascript:alert(1)', 'https://a.test?x=1', 'https://u:p@a.test']) {
      assert.throws(() => parsePublicBase(v), PublicBaseError, `${JSON.stringify(v)} was accepted`);
      assert.throws(() => parsePublicBase(v), /PUBLIC_URL/);
    }
    assert.throws(() => parsePublicBaseList('https://a.test,nonsense'), /PUBLIC_URL_ALLOWED_ORIGINS/);
  });

  test('normaliseHostHeader accepts a bare host and nothing else', () => {
    assert.equal(normaliseHostHeader('a.test'), 'a.test');
    assert.equal(normaliseHostHeader('A.Test:8080'), 'a.test:8080');
    assert.equal(normaliseHostHeader('a.test:80', 'http:'), 'a.test', 'the default port is dropped under its own scheme');
    assert.equal(normaliseHostHeader('a.test:80', 'https:'), 'a.test:80', 'and kept under a different one');
    assert.equal(normaliseHostHeader('[::1]:8080'), '[::1]:8080');
    for (const bad of ['', 'a.test/p', 'a.test?q', 'a.test#f', 'a.test\\p', 'u@a.test', 'a.test\r\nX: y', 'a.test ', 'xn--é.test', ' a.test', 'a.test ', 'a'.repeat(300), 42, null, ['a.test']]) {
      assert.equal(normaliseHostHeader(bad), null, `${JSON.stringify(bad)} was accepted as a host`);
    }
  });

  test('the loopback predicates', () => {
    for (const h of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:4000', '127.1.2.3', '[::1]', '[::1]:9']) assert.equal(isLoopbackHostHeader(h), true, h);
    for (const h of ['127.0.0.1.evil.example', 'localhost.evil.example', '0.0.0.0', '10.0.0.1', '[::2]', 'evil.example', '']) assert.equal(isLoopbackHostHeader(h), false, h);
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1', '127.5.5.5']) assert.equal(isLoopbackAddress(a), true, a);
    for (const a of ['10.0.0.1', '172.18.0.4', '203.0.113.7', '::ffff:10.0.0.1', '', undefined, null]) assert.equal(isLoopbackAddress(a), false, String(a));
  });

  test('resolvePublicBaseEnv never throws at load; it hands back the error to check at startup', () => {
    const bad = resolvePublicBaseEnv({ PUBLIC_URL: 'nonsense' });
    assert.ok(bad.error instanceof PublicBaseError);
    assert.throws(() => bad.resolve({ headers: {}, socket: {} }), /PUBLIC_URL/);
    const good = resolvePublicBaseEnv({ PUBLIC_URL: 'https://a.test' });
    assert.equal(good.error, null);
    assert.equal(good.resolve({ headers: { host: 'evil.example' }, socket: {} }), 'https://a.test');
  });

  test('server.mjs and manga-routes.mjs share ONE resolver, not two copies of a derivation', async () => {
    // The whole reason this lives in validators.mjs. The previous two helpers were byte-identical
    // under a comment promising they agreed — and they did agree, on trusting Host.
    const [server, manga] = await Promise.all([
      fs.readFile(path.join(HERE, '..', 'src', 'server.mjs'), 'utf8'),
      fs.readFile(path.join(HERE, '..', 'src', 'manga-routes.mjs'), 'utf8'),
    ]);
    for (const [name, src] of [['server.mjs', server], ['manga-routes.mjs', manga]]) {
      assert.match(src, /resolvePublicBaseEnv/, `${name} does not use the shared resolver`);
      assert.doesNotMatch(src, /\$\{req\.protocol\}/, `${name} interpolates req.protocol into a URL again`);
      assert.doesNotMatch(src, /\$\{[^}]*req\.headers\.host/, `${name} interpolates req.headers.host into a URL again`);
    }
  });
});

// =================================================================================================
// 2. /manga/read over HTTP — the route the bug was found on
// =================================================================================================

describe('/manga/read link origin', () => {
  const read = (port, headers) => rawGet(port, '/manga/read?provider=FakeDex&chapterId=ch-1', headers);
  const firstImg = body => JSON.parse(body).pages[0].img;

  describe('nothing configured', () => {
    let port;
    let child;
    before(async () => ({ port, child } = await boot(HARNESS, { PUBLIC_URL: '' }, '/manga/image')), { timeout: 60_000 });
    after(() => child?.kill('SIGKILL'));

    test('a forged Host is REFUSED, loudly, instead of appearing in pages[].img', async () => {
      for (const host of ['evil.attacker.example', 'evil.attacker.example:8443', 'evil.attacker.example@x.test']) {
        const r = await read(port, { Host: host });
        assert.equal(r.status, 500, `Host ${host} was accepted`);
        assert.doesNotMatch(r.body, /evil\.attacker\.example/, 'the forged host reached the response body');
        assert.match(JSON.parse(r.body).error, /Set PUBLIC_URL/);
      }
    });

    test('X-Forwarded-Host cannot forge it either', async () => {
      const r = await read(port, { 'X-Forwarded-Host': 'evil.attacker.example' });
      assert.equal(r.status, 200);
      assert.ok(firstImg(r.body).startsWith(`http://127.0.0.1:${port}/manga/image?`), firstImg(r.body));
    });

    test('local dev still works with no configuration at all', async () => {
      const r = await read(port, {});
      assert.equal(r.status, 200);
      assert.ok(firstImg(r.body).startsWith(`http://127.0.0.1:${port}/manga/image?url=`), firstImg(r.body));
    });
  });

  describe('PUBLIC_URL configured (the production path)', () => {
    let port;
    let child;
    before(async () => ({ port, child } = await boot(HARNESS, { PUBLIC_URL: 'https://api.example.test/' }, '/manga/image')), { timeout: 60_000 });
    after(() => child?.kill('SIGKILL'));

    test('every link uses the configured origin, whatever the Host says', async () => {
      for (const host of [undefined, 'evil.attacker.example', 'evil.attacker.example:8443', '[2001:db8::1]:9999']) {
        const r = await read(port, host === undefined ? {} : { Host: host });
        assert.equal(r.status, 200);
        assert.ok(firstImg(r.body).startsWith('https://api.example.test/manga/image?url='), firstImg(r.body));
        assert.doesNotMatch(r.body, /evil\.attacker\.example|2001:db8/);
      }
    });
  });

  describe('PUBLIC_URL_ALLOWED_ORIGINS configured', () => {
    let port;
    let child;
    before(
      async () =>
        ({ port, child } = await boot(
          HARNESS,
          { PUBLIC_URL: 'https://api.example.test', PUBLIC_URL_ALLOWED_ORIGINS: 'https://alt.example.test' },
          '/manga/image'
        )),
      { timeout: 60_000 }
    );
    after(() => child?.kill('SIGKILL'));

    test('an allowlisted Host selects its origin; anything else gets the default', async () => {
      const alt = await read(port, { Host: 'alt.example.test' });
      assert.ok(firstImg(alt.body).startsWith('https://alt.example.test/manga/image?url='), firstImg(alt.body));
      const evil = await read(port, { Host: 'evil.attacker.example' });
      assert.ok(firstImg(evil.body).startsWith('https://api.example.test/manga/image?url='), firstImg(evil.body));
    });
  });
});

// =================================================================================================
// 3. the REAL server.mjs — /watch, and startup validation
// =================================================================================================

describe('src/server.mjs', () => {
  let port;
  let child;
  before(async () => ({ port, child } = await boot(SERVER, { PUBLIC_URL: '' }, '/')), { timeout: 60_000 });
  after(() => child?.kill('SIGKILL'));

  test('/watch refuses a forged Host before it calls a provider', async () => {
    // Offline by construction: the base is resolved BEFORE the aggregator, so this never opens a
    // socket. `p` is not a registered provider, which is irrelevant — we never get that far.
    const r = await rawGet(port, '/watch?provider=p&episodeId=e', { Host: 'evil.attacker.example' });
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.body, /evil\.attacker\.example/);
    assert.match(JSON.parse(r.body).error, /Set PUBLIC_URL/);
  });

  test('a local /watch gets past the base check (and then fails on the unknown provider, not on the base)', async () => {
    const r = await rawGet(port, '/watch?provider=p&episodeId=e');
    assert.notEqual(r.status, 500, `base resolution rejected a local request: ${r.body}`);
    assert.doesNotMatch(r.body, /PUBLIC_URL/);
  });

  test('the /proxy playlist rewrite uses the SAME checked base', async () => {
    // SOURCE INSPECTION, and here is why it cannot be an end-to-end test: the playlist branch is
    // only reached after a successful upstream fetch, and /proxy's SSRF guard (correctly) refuses
    // every loopback and private target, so no offline listener can ever be that upstream. The
    // assertion is therefore that the branch consumes `base` from baseOr500() — the same helper the
    // /watch test above exercises for real — rather than re-deriving anything of its own.
    const src = await fs.readFile(SERVER, 'utf8');
    assert.equal((src.match(/baseOr500\(req, reply\)/g) || []).length, 2, 'expected exactly two guarded base resolutions');
    assert.match(src, /rewriteM3U8\(text, new URL\(target\), ref, base,/, 'the playlist rewrite no longer takes the checked base');
    assert.doesNotMatch(src, /rewriteM3U8\([^)]*proxyBase\(req\)/, 'the playlist rewrite resolves its own base again');
    assert.match(src, /const wrap = \(u, pk, km, aud\) =>[^;]*wrapUrl\(base,/, '/watch no longer wraps against the checked base');
  });
});

test('a malformed PUBLIC_URL kills startup with the variable named, instead of listening', async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(await freePort()), NODE_ENV: 'test', PUBLIC_URL: 'evil.attacker.example' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => (log += d));
  child.stderr.on('data', d => (log += d));
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit; it is listening with a bad PUBLIC_URL:\n${log}`));
    }, 30_000);
    child.on('exit', c => {
      clearTimeout(t);
      resolve(c);
    });
  });
  assert.equal(code, 1);
  assert.match(log, /refusing to start/);
  assert.match(log, /PUBLIC_URL is not an absolute URL/);
}, { timeout: 60_000 });
