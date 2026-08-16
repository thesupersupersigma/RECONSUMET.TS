// Black-box tests for GET /manga/image — the Referer-injecting, image-ONLY page proxy.
//
// WHY A FAKED SOCKET LAYER, AND WHAT IS STILL REAL. The success path of an SSRF-guarded proxy is
// untestable with real sockets: any local upstream lives on 127.0.0.1, and 127.0.0.1 is exactly
// what `assertUrlSafe` blocks. A suite limited to real sockets could therefore prove REJECTION and
// nothing else — not the Referer, not the absence of Origin, not the sniffing, not the ceiling.
//
// So the route's fetch is injected (`opts.imageFetch`, the same pattern ssrf-guard.mjs already uses
// for `fetchImpl`/`lookup`) and ONLY the socket is fake. Real in every test below: `assertUrlSafe`,
// the whole redirect walk in `followSafeRedirects`, the content sniffing, the byte counter, the
// header handling, Fastify routing and serialisation. The synthetic upstream is the literal public
// IP 1.1.1.1, which the guard accepts without touching DNS and which is never contacted.
//
// The one test that could not be faked honestly is the redirect-SSRF one, so it is not: a REAL
// loopback canary server is running, it serves REAL JPEG bytes with a secret in them, and the
// fixture's fake fetch HONOURS `init.redirect` — meaning a route rewritten as a plain
// `fetch(url, { redirect: 'follow' })` really does reach the canary and really does hand its bytes
// back. See the header of fixtures/manga-fake-server.mjs.
//
// Fully offline. Run: cd api && node --test 'test/**/*.test.mjs'

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DIRECT_IMAGE_HOSTS,
  MANGA_IMAGE_MAX_BYTES,
  isDirectImageHost,
  mangaImageProxy,
  sniffImageMime,
} from '../src/manga-routes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'fixtures', 'manga-fake-server.mjs');
const ROUTES = path.join(HERE, '..', 'src', 'manga-routes.mjs');

/** Small enough that the streaming ceiling fires in milliseconds; the fixture's oversized body is
 *  64 KB, so nothing legitimate is anywhere near it. */
const CEILING = 4096;

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

// The canary answers with something the route would happily relay if it ever got there: real JPEG
// magic bytes and a real content-type, with the secret in the payload. A guard failure is then a
// 200 full of secret rather than a subtle counter change.
const CANARY_BODY = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('SECRET-CANARY-BODY')]);

before(async () => {
  const canaryPort = await freePort();
  canary = http.createServer((_req, res) => {
    canaryHits++;
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(CANARY_BODY.length) });
    res.end(CANARY_BODY);
  });
  await new Promise(r => canary.listen(canaryPort, '127.0.0.1', r));
  canaryUrl = `http://127.0.0.1:${canaryPort}/page-1.jpg`;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [HARNESS], {
    env: {
      ...process.env,
      PORT: String(port),
      IMAGE_CANARY_URL: canaryUrl,
      MANGA_IMAGE_MAX_BYTES: String(CEILING),
      // Deliberately unset: the local-dev path, where a link origin may be derived from the request
      // because both the Host and the raw socket peer are loopback. Not the deployed default —
      // that requires PUBLIC_URL and 500s without it. See "THE PUBLIC BASE" in src/validators.mjs.
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

const img = (pathname, ref) =>
  fetch(
    `${base}/manga/image?url=${encodeURIComponent(`https://1.1.1.1${pathname}`)}` +
      (ref === undefined ? '' : `&ref=${encodeURIComponent(ref)}`)
  );

/** Every header set the route actually sent upstream, read back out of the harness process. */
const upstreamCalls = async () => (await fetch(`${base}/__image-calls`)).json();

// ---------------------------------------------------------------- Referer in, Origin never out

test('injects the Referer it was given, verbatim', async () => {
  const res = await img('/ok.jpg', 'https://mangapill.com/');
  await res.arrayBuffer();
  const calls = await upstreamCalls();
  const last = calls[calls.length - 1];
  assert.equal(last.url, 'https://1.1.1.1/ok.jpg');
  // The whole reason this route exists: cdn.readdetectiveconan.com is 403 without exactly this.
  assert.equal(last.headers.Referer, 'https://mangapill.com/');
  assert.match(last.headers['User-Agent'], /Chrome/, 'a bot UA is what several of these CDNs 403');
});

test('sends no Referer at all when none was given, rather than inventing one', async () => {
  const res = await img('/ok.jpg');
  await res.arrayBuffer();
  const calls = await upstreamCalls();
  assert.ok(!('Referer' in calls[calls.length - 1].headers));
});

// THE MANGADEX TRAP. Its CDN answers `Vary: Origin, Referer`: an Origin alone gets HTTP 404 and
// zero bytes, and Origin+Referer gets a 59,480-byte placeholder JPEG instead of the 767,192-byte
// page. A browser cannot suppress Origin on a CORS-mode load, so this hop is the only thing that
// can — and only for as long as it never sends one itself.
test('NEVER sends an Origin header, on any request, for any reason', async () => {
  // Including when the caller tries hard to make it, via a header, a query param and a Referer.
  await (
    await fetch(`${base}/manga/image?url=${encodeURIComponent('https://1.1.1.1/ok.jpg')}&org=https%3A%2F%2Fevil.example`, {
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
    })
  ).arrayBuffer();
  await (await img('/ok.jpg', 'https://mangadex.org/')).arrayBuffer();

  const calls = await upstreamCalls();
  assert.ok(calls.length > 0, 'no upstream call was recorded — the test proves nothing');
  for (const c of calls) {
    const names = Object.keys(c.headers).map(h => h.toLowerCase());
    assert.ok(!names.includes('origin'), `an Origin header reached ${c.url}: ${JSON.stringify(c.headers)}`);
  }
});

test("strips newlines from 'ref' before it becomes a request header", async () => {
  const res = await img('/ok.jpg', 'https://mangapill.com/\r\nX-Injected: yes');
  await res.arrayBuffer();
  const sent = (await upstreamCalls()).at(-1).headers.Referer;
  assert.ok(!/[\r\n]/.test(sent), `header injection survived: ${JSON.stringify(sent)}`);
  assert.equal(sent, 'https://mangapill.com/X-Injected: yes');
});

test("rejects a 'ref' that is not an http(s) url", async () => {
  for (const ref of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'mangapill.com']) {
    const res = await img('/ok.jpg', ref);
    assert.equal(res.status, 400, ref);
    assert.match((await res.json()).error, /'ref' must be an http\(s\) url/, ref);
  }
});

test("rejects a repeated 'url' or 'ref' instead of letting an array skip the string guards", async () => {
  const dup = await fetch(
    `${base}/manga/image?url=${encodeURIComponent('https://1.1.1.1/ok.jpg')}&url=${encodeURIComponent('https://1.1.1.1/lying.png')}`
  );
  assert.equal(dup.status, 400);
  assert.match((await dup.json()).error, /at most once/);

  const dupRef = await fetch(
    `${base}/manga/image?url=${encodeURIComponent('https://1.1.1.1/ok.jpg')}&ref=https%3A%2F%2Fa.example%2F&ref=https%3A%2F%2Fb.example%2F`
  );
  assert.equal(dupRef.status, 400);
  assert.match((await dupRef.json()).error, /at most once/);
});

// ---------------------------------------------------------------- the happy path

test('serves the bytes, with ACAO and nosniff, and never buffers a whole page to do it', async () => {
  const res = await img('/ok.jpg', 'https://mangapill.com/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*'); // the thing a direct CDN link cannot do
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 604);
  assert.equal(body.subarray(0, 4).toString('hex'), 'ffd8ffe0', 'the sniffed head was not re-emitted');
  assert.equal(body.subarray(4, 8).toString(), 'AAAA', 'the tail after the sniff head was lost');
});

test("mirrors the CDN's own Cache-Control and ETag rather than inventing a policy", async () => {
  const res = await img('/cached.webp');
  await res.arrayBuffer();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(res.headers.get('etag'), '"abc"');
});

test('falls back to a conservative TTL only when the CDN states none', async () => {
  const res = await img('/nocache.png');
  await res.arrayBuffer();
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
});

test('follows a redirect that stays public, transparently', async () => {
  const res = await img('/redir-public');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal((await res.arrayBuffer()).byteLength, 604);
});

// ---------------------------------------------------------------- the content-type lies

// WeebCentral serves a `.png` url with `Content-Type: image/png` and ffd8ffe1 (JPEG) bytes —
// re-measured live at 847,836 B. The route must believe the bytes.
test('answers with the SNIFFED type when the upstream header lies', async () => {
  const res = await img('/lying.png');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg', 'the lying header was trusted');
  assert.equal(body.subarray(0, 4).toString('hex'), 'ffd8ffe0');
});

test('rejects a non-image content-type without relaying the body', async () => {
  const res = await img('/blocked');
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.match(text, /not an image \(content-type: text\/html\)/);
  assert.ok(!text.includes('you have been blocked'), 'the upstream HTML body was relayed');
});

// The one a header allowlist alone misses: HTML wearing an image content-type.
test('rejects HTML that claims to be an image, because the bytes decide', async () => {
  const res = await img('/liar.jpg');
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.match(text, /declared image\/jpeg but the bytes are not a supported image/);
  assert.ok(!text.includes('you have been blocked'));
});

// An SVG served from OUR origin and opened directly is a document that can run script. Magic-byte
// allowlisting closes that without a special case, because SVG has no magic number.
test('rejects an SVG, closing the open-image-proxy XSS vector', async () => {
  const res = await img('/xss.svg');
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!text.includes('<script>'), 'script-bearing SVG was relayed');
});

test('reports an upstream non-2xx as 502 without relaying its status or its body', async () => {
  const res = await img('/403');
  assert.equal(res.status, 502, 'a 403 block page was relayed as a 403');
  const text = await res.text();
  assert.match(text, /image upstream returned 403/);
  assert.ok(!text.includes('you have been blocked'));
});

test('rejects an empty 200 rather than serving a zero-byte image', async () => {
  const res = await img('/empty.jpg');
  assert.equal(res.status, 502);
  assert.match(await res.text(), /not a supported image/);
});

// ---------------------------------------------------------------- the size ceiling

test('refuses a declared length over the ceiling before reading a single byte of body', async () => {
  const res = await img('/toobig-declared.jpg');
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, new RegExp(`over the ${CEILING}-byte ceiling`));
});

// FlameComics serves ~1 MB pages live and the brief measured 3.5 MB on a long strip, so the ceiling
// is generous in production — but an upstream that declares nothing and streams forever is the
// case a declared-length check cannot catch, and it is the one that makes an open proxy a
// bandwidth amplifier.
test('stops a body that streams past the ceiling without declaring a length', async () => {
  const res = await img('/toobig-stream.jpg');
  assert.equal(res.status, 200, 'headers are already sent by then — the stream is what must stop');
  let bytes = -1;
  let err = null;
  try {
    bytes = (await res.arrayBuffer()).byteLength;
  } catch (e) {
    err = e;
  }
  assert.ok(
    err !== null || bytes <= CEILING,
    `the ceiling did not stop the stream: got ${bytes} bytes for a ${64 * 1024 + 604}-byte body`
  );
});

// ---------------------------------------------------------------- SSRF

test('rejects a private-range url before any socket is opened', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:9/page.png',
    'http://10.0.0.5/internal.png',
    'http://[::1]/x.png',
    'https://[::ffff:169.254.169.254]/x.png',
    'http://localhost:9/x.png',
    'file:///etc/passwd',
  ]) {
    const res = await fetch(`${base}/manga/image?url=${encodeURIComponent(url)}`);
    assert.equal(res.status, 400, `${url} → ${res.status}`);
    assert.match((await res.json()).error, /'url' rejected/, url);
  }
});

test('never contacts a blocked target named directly', async () => {
  const before = canaryHits;
  const res = await fetch(`${base}/manga/image?url=${encodeURIComponent(canaryUrl)}`);
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.ok(!text.includes('SECRET-CANARY-BODY'));
  assert.equal(canaryHits, before, 'the guard let a request through to the internal service');
});

// THE ONE THAT MATTERS. A public URL that 302s into the blocked range is the vector a plain
// `fetch(url, { redirect: 'follow' })` reopens, and the fixture's fake fetch follows redirects
// exactly as undici would — so if followSafeRedirects is ever swapped out, this really does hit the
// loopback canary and really does hand its bytes to the client.
test('re-validates every redirect hop, and never follows one into a blocked range', async () => {
  const before = canaryHits;
  const res = await img('/redir-private');
  assert.equal(res.status, 400, 'a redirect into the blocked range was not refused');
  const text = await res.text();
  assert.match(text, /'url' rejected/);
  assert.ok(!text.includes('SECRET-CANARY-BODY'), 'internal response body leaked through /manga/image');
  assert.equal(canaryHits, before, 'a redirect reached the internal service');
});

// ---------------------------------------------------------------- the pieces, in process

test('sniffImageMime accepts the formats these CDNs actually serve and nothing else', () => {
  const b = (...parts) => Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  assert.equal(sniffImageMime(b([0xff, 0xd8, 0xff, 0xe0], 'JFIF')), 'image/jpeg');
  assert.equal(sniffImageMime(b([0xff, 0xd8, 0xff, 0xe1], 'Exif')), 'image/jpeg'); // WeebCentral's real bytes
  assert.equal(sniffImageMime(b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffImageMime(b('GIF89a')), 'image/gif');
  assert.equal(sniffImageMime(b('RIFF', [0, 0, 0, 0], 'WEBP')), 'image/webp'); // AsuraScans' real bytes
  assert.equal(sniffImageMime(b([0, 0, 0, 0x20], 'ftyp', 'avif')), 'image/avif');
  assert.equal(sniffImageMime(b('BM', [0, 0, 0, 0])), 'image/bmp');

  // Everything that is not a raster image, including the two that matter.
  assert.equal(sniffImageMime(b('<svg xmlns=')), undefined, 'SVG is an XSS vector, not an image');
  assert.equal(sniffImageMime(b('<!DOCTYPE html>')), undefined);
  assert.equal(sniffImageMime(b('%PDF-1.7')), undefined);
  assert.equal(sniffImageMime(b('RIFF', [0, 0, 0, 0], 'WAVE')), undefined, 'RIFF alone is not WebP');
  assert.equal(sniffImageMime(b([0xff, 0xd8])), undefined, 'a two-byte prefix is not enough to accept');
  assert.equal(sniffImageMime(Buffer.alloc(0)), undefined);
  assert.equal(sniffImageMime(undefined), undefined);
});

test('the ceiling is a real number, generous enough for a 3.5 MB long-strip page', () => {
  // Sanity, not taste: a ceiling under the largest page ever measured would break real chapters.
  assert.ok(MANGA_IMAGE_MAX_BYTES >= 3.5 * 1024 * 1024, `${MANGA_IMAGE_MAX_BYTES} is under the largest page seen`);
});

// The per-provider `needsProxy` switch. It ships OFF — see "DOES EVERY IMAGE NEED THE PROXY?" in
// manga-routes.mjs — so the default here is "proxy everything", and pages[].img is unchanged from
// what B4 shipped.
test('by default every image is proxied, so the shipped pages[].img contract is unchanged', () => {
  assert.deepEqual(DIRECT_IMAGE_HOSTS, []);
  for (const u of [
    'https://cdn.asurascans.com/asura-images/chapters/x/1/001.webp',
    'https://hot.planeptune.us/manga/Solo-Leveling/0000-001.png',
    'https://cdn.readdetectiveconan.com/file/mangap/8136/10001000/1.jpeg',
  ]) {
    assert.equal(isDirectImageHost(u), false, u);
    assert.ok(mangaImageProxy(u, 'https://x.example/').startsWith('/manga/image?url='), u);
  }
});

// MANGA_DIRECT_IMAGE_HOSTS is read at module load, so this runs in a child process — which also
// proves the env plumbing itself, not just the matcher.
test('MANGA_DIRECT_IMAGE_HOSTS turns the proxy off per host, suffix-matched', () => {
  const script = `
    import { isDirectImageHost, mangaImageProxy } from ${JSON.stringify(ROUTES)};
    const urls = [
      'https://hot.planeptune.us/manga/Solo-Leveling/0000-001.png',
      'https://scans-hot.planeptune.us/manga/x/1.png',
      'https://cdn.flamecomics.xyz/uploads/images/series/1/a/01.jpg',
      'https://cdn.readdetectiveconan.com/file/mangap/1/1.jpeg',
      'https://evilplaneptune.us/x.png',
      'not a url'
    ];
    console.log(JSON.stringify(urls.map(u => [isDirectImageHost(u), mangaImageProxy(u, 'https://r.example/')])));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MANGA_DIRECT_IMAGE_HOSTS: ' planeptune.us , cdn.flamecomics.xyz ' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  // The host that rotates: the registry names official.lowee.us / scans-hot.planeptune.us, live it
  // was hot.planeptune.us. A suffix match covers all three; an exact-host list would not.
  assert.deepEqual(out[0], [true, 'https://hot.planeptune.us/manga/Solo-Leveling/0000-001.png']);
  assert.deepEqual(out[1], [true, 'https://scans-hot.planeptune.us/manga/x/1.png']);
  assert.deepEqual(out[2], [true, 'https://cdn.flamecomics.xyz/uploads/images/series/1/a/01.jpg']);
  // MangaPill 403s a browser's Referer, so it must stay proxied even if someone lists it by mistake
  // elsewhere — here it is simply not listed, and gets a proxy link.
  assert.equal(out[3][0], false);
  assert.ok(out[3][1].startsWith('/manga/image?url='));
  // A suffix match must be on a LABEL boundary, not a substring.
  assert.equal(out[4][0], false, 'evilplaneptune.us matched the planeptune.us suffix');
  // An unparseable url falls toward the proxy, never toward a raw link.
  assert.equal(out[5][0], false);
});
