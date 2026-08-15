// Black-box tests for the values /proxy puts into OUTBOUND REQUEST HEADERS: `ref` (Referer),
// `org` (Origin) and `km` (x-am-media-id).
//
// WHAT WAS ACTUALLY WRONG, STATED HONESTLY. This route was reported as "header injection", with
// `ref=https://a.example/X-Injected: pwned` as the payload. It is not injection, and these tests
// are written so that they say so:
//
//   * A colon in a header VALUE is legal. Over the wire that payload is ONE `Referer` line with an
//     odd value. Measured against a loopback listener echoing rawHeaders: one `referer`, zero
//     `x-injected`.
//   * CR/LF cannot survive either transport. undici throws out of Headers.append on the plain-fetch
//     path (/proxy turns that into a 502), and the curl-impersonate path passes each header as ONE
//     element of a spawn() argv array with no shell — `-H` and `${k}: ${v}` cannot be split by
//     anything the value contains. `argvHeaders` below asserts exactly that, on the real path.
//
// What WAS wrong is that /proxy never checked the SHAPE of these values while its younger sibling
// /manga/image has scheme-checked its own `ref` all along: `ref=javascript:alert(1)` became a
// `Referer: javascript:alert(1)` AND an `Origin: null` upstream (impersonatedFetch derives an
// Origin from the referer), and `org` could carry a path, which a serialized origin cannot. Those
// are the things these tests pin.
//
// THE ARGV PATH IS REAL HERE, NOT SIMULATED. `CURL_IMPERSONATE_BIN` is just a path, so it points at
// test/fixtures/fake-curl.mjs, which speaks the fd-3-headers / fd-1-body protocol the real binary
// speaks and returns its own argv as the body. `TLS_IMPERSONATE_HOSTS=1.1.1.1` routes the literal
// public IP 1.1.1.1 (accepted by the SSRF guard without touching DNS, never contacted) down that
// path. So every assertion below is on the bytes server.mjs really assembled.
//
// MUTATION SENSITIVITY: delete the three validation blocks from /proxy and the rejection tests all
// fail — the hostile values stop 400ing and instead show up in the fake curl's argv log, which
// each of those tests also asserts stays empty. Counts are in the item report.
//
// Fully offline: nothing is fetched, the only child processes are the server and the fake curl,
// and a loopback canary is running to prove no socket is opened to it.
//
// Run: cd api && node --test 'test/**/*.test.mjs'

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'server.mjs');
const FAKE_CURL = path.join(HERE, 'fixtures', 'fake-curl.mjs');

/** Suffix-matched by needsImpersonation(), and a literal public IP the SSRF guard accepts. */
const TARGET = 'http://1.1.1.1/seg.ts';

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
let curlLog;
let tmpDir;
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-hdr-'));
  curlLog = path.join(tmpDir, 'curl-argv.log');
  fs.writeFileSync(curlLog, '');
  // The committed file mode is not something a test should depend on; spawn() needs +x.
  fs.chmodSync(FAKE_CURL, 0o755);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      CURL_IMPERSONATE_BIN: FAKE_CURL,
      CURL_IMPERSONATE_ARGS: '',
      TLS_IMPERSONATE_HOSTS: '1.1.1.1',
      FAKE_CURL_LOG: curlLog,
    },
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
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => fs.writeFileSync(curlLog, ''));

const q = encodeURIComponent;
/** Invocations of the upstream stand-in since the last test started. */
const curlInvocations = () => fs.readFileSync(curlLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

/** GET /proxy and, on success, parse the fake curl's argv out of the body. */
const proxy = async qs => {
  const res = await fetch(`${base}/proxy?${qs}`);
  const text = await res.text();
  let argv = null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) argv = parsed;
  } catch {
    /* an error body, not an argv dump */
  }
  return { res, text, argv, json: argv ? {} : safeJson(text) };
};
const safeJson = t => {
  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
};

/** Every `-H` value in an argv array, in order. */
const argvHeaders = argv => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '-H') out.push(argv[i + 1]);
  return out;
};
const headerMap = argv =>
  Object.fromEntries(
    argvHeaders(argv).map(h => {
      const i = h.indexOf(': ');
      return [h.slice(0, i).toLowerCase(), h.slice(i + 2)];
    })
  );

// --------------------------------------------------------- the framing measurement (the honest bit)

test('the curl-impersonate argv path emits one argv element per header, and no value can split it', async () => {
  const { res, argv } = await proxy(`url=${q(TARGET)}&ref=${q('https://a.example/')}`);
  assert.equal(res.status, 200);
  assert.ok(argv, 'the fake curl did not run — the argv path was never exercised');

  const hs = argvHeaders(argv);
  assert.ok(hs.length >= 7, `too few headers to be the real set: ${JSON.stringify(hs)}`);
  // one -H flag per value, nothing unpaired, and no framing character anywhere in argv
  assert.equal(argv.filter(a => a === '-H').length, hs.length);
  for (const a of argv) assert.doesNotMatch(a, /[\r\n]/, `a framing character reached argv: ${JSON.stringify(a)}`);
  // header names are unique: a second Referer would be the actual injection primitive
  const names = hs.map(h => h.slice(0, h.indexOf(':')).toLowerCase());
  assert.equal(new Set(names).size, names.length, `duplicate header name in argv: ${JSON.stringify(names)}`);

  const m = headerMap(argv);
  assert.equal(m.referer, 'https://a.example/');
  assert.equal(m.origin, 'https://a.example', 'Origin is derived from the referer when no org is given');
  assert.equal(argv.at(-1), TARGET, 'the target must be the last argv element');
  assert.equal(curlInvocations().length, 1);
});

// --------------------------------------------------------------------------------- ref (Referer)

test("rejects a 'ref' that is not an http(s) url, and never spawns the upstream", async () => {
  for (const ref of [
    'javascript:alert(1)', // used to become BOTH a Referer and `Origin: null`
    'data:text/html,x',
    'file:///etc/passwd',
    'a.example', // scheme-less
    'https://', // parses in the old /^https?:\/\// regex, has no host
    '-H', // an argv-shaped value: harmless, but still not a URL
    canaryUrl.replace('http://', 'gopher://'),
  ]) {
    const { res, json } = await proxy(`url=${q(TARGET)}&ref=${q(ref)}`);
    assert.equal(res.status, 400, `${ref} → ${res.status}`);
    assert.match(json.error, /'ref' must be an http\(s\) url/, ref);
  }
  assert.deepEqual(curlInvocations(), [], 'a rejected ref still reached the upstream stand-in');
});

test("rejects a CR/LF-bearing 'ref' outright instead of silently repairing it", async () => {
  // Both matter: `new URL()` DELETES tab/CR/LF per the WHATWG parser, so a URL parse alone would
  // have accepted every one of these and quietly changed the value.
  for (const ref of [
    'https://a.example/\r\nX-Injected: pwned',
    'https://a.example/\nX-Injected: pwned',
    'https://a.example/\rX',
    'https://a.example/\tX',
    'https://a.example/ X',
  ]) {
    const { res, json } = await proxy(`url=${q(TARGET)}&ref=${q(ref)}`);
    assert.equal(res.status, 400, `${JSON.stringify(ref)} → ${res.status}`);
    assert.match(json.error, /'ref' must be an http\(s\) url/, JSON.stringify(ref));
  }
  assert.deepEqual(curlInvocations(), [], 'a CRLF-bearing ref still reached the upstream stand-in');
});

test("a colon in 'ref' is a legal header value, not a second header — and is still carried", async () => {
  // The reported "injection" payload. It is accepted (a space and a colon are both legal in a
  // header value and neither can split a line or an argv element) and it arrives as ONE header.
  const ref = 'https://a.example/X-Injected: pwned';
  const { res, argv } = await proxy(`url=${q(TARGET)}&ref=${q(ref)}`);
  assert.equal(res.status, 200);
  const hs = argvHeaders(argv);
  assert.equal(hs.filter(h => /^referer:/i.test(h)).length, 1, 'more than one Referer in argv');
  assert.equal(hs.filter(h => /^x-injected:/i.test(h)).length, 0, 'an X-Injected header materialised');
  assert.equal(headerMap(argv).referer, ref);
});

test('an ordinary request with no ref still works and sends no Referer', async () => {
  const { res, argv } = await proxy(`url=${q(TARGET)}`);
  assert.equal(res.status, 200);
  const m = headerMap(argv);
  assert.equal(m.referer, undefined);
  assert.equal(m.origin, 'http://1.1.1.1', 'with no referer the Origin falls back to the target');
});

test("an empty 'ref' is treated as absent, not as an invalid url", async () => {
  const { res, argv } = await proxy(`url=${q(TARGET)}&ref=`);
  assert.equal(res.status, 200);
  assert.equal(headerMap(argv).referer, undefined);
});

// ----------------------------------------------------------------------------------- org (Origin)

test("accepts a serialized origin for 'org' and normalises it", async () => {
  for (const [org, expected] of [
    ['https://krussdomi.com', 'https://krussdomi.com'], // the one this codebase actually produces
    ['https://krussdomi.com/', 'https://krussdomi.com'], // a trailing slash is the tolerated slop
    ['http://a.example:8443', 'http://a.example:8443'], // a non-default port is part of the origin
  ]) {
    const { res, argv } = await proxy(`url=${q(TARGET)}&org=${q(org)}`);
    assert.equal(res.status, 200, org);
    assert.equal(headerMap(argv).origin, expected, org);
  }
});

test("rejects an 'org' that is not a serialized origin", async () => {
  for (const org of [
    'https://a.example/segments/', // AN ORIGIN HAS NO PATH — the whole reason org is not validated
    'https://a.example/?x=1', //     with the referer's rule
    'https://a.example/#f',
    'https://user:pw@a.example',
    'https://a.example X-Injected: pwned',
    'https://a.example\r\nX-Injected: pwned',
    'javascript:alert(1)',
    'a.example',
  ]) {
    const { res, json } = await proxy(`url=${q(TARGET)}&org=${q(org)}`);
    assert.equal(res.status, 400, `${JSON.stringify(org)} → ${res.status}`);
    assert.match(json.error, /'org' must be a serialized origin/, JSON.stringify(org));
  }
  assert.deepEqual(curlInvocations(), [], 'a rejected org still reached the upstream stand-in');
});

test("a caller-supplied 'org' overrides the referer-derived Origin, and only once", async () => {
  const { res, argv } = await proxy(`url=${q(TARGET)}&ref=${q('https://a.example/')}&org=${q('https://b.example')}`);
  assert.equal(res.status, 200);
  const hs = argvHeaders(argv);
  assert.equal(hs.filter(h => /^origin:/i.test(h)).length, 1, 'two Origin headers in argv');
  assert.equal(headerMap(argv).origin, 'https://b.example');
});

// ------------------------------------------------------------------------- km (x-am-media-id)

test("carries a well-formed 'km' as x-am-media-id, but only on a key.bin target", async () => {
  const withKey = await proxy(`url=${q('http://1.1.1.1/key.bin')}&km=${q('9f3a-abc_DEF.42')}`);
  // key.bin bodies go through the AES derivation, which this fixture's body is not — a 502 from
  // THAT step still proves the header was assembled and sent, which is what is under test.
  assert.equal(headerMap(curlInvocations()[0])['x-am-media-id'], '9f3a-abc_DEF.42', withKey.text);

  const notKeyBin = await proxy(`url=${q(TARGET)}&km=${q('9f3a-abc_DEF.42')}`);
  assert.equal(notKeyBin.res.status, 200);
  assert.equal(headerMap(notKeyBin.argv)['x-am-media-id'], undefined, 'km leaked onto a non-key.bin request');
});

test("rejects a 'km' that is not a printable, space-free token", async () => {
  for (const km of ['a b', 'a\r\nX-Injected: pwned', 'a\nb', ' ', 'x'.repeat(257)]) {
    const { res, json } = await proxy(`url=${q('http://1.1.1.1/key.bin')}&km=${q(km)}`);
    assert.equal(res.status, 400, `${JSON.stringify(km)} → ${res.status}`);
    assert.match(json.error, /'km' must be a printable token/, JSON.stringify(km));
  }
  assert.deepEqual(curlInvocations(), [], 'a rejected km still reached the upstream stand-in');
});

// ------------------------------------------------------ the other side of the shared validator

test('/manga/image gets the same referer validator, and it is stricter than the regex it replaced', async () => {
  // The point of lifting the check into src/validators.mjs: BOTH routes move together. These two
  // values passed /manga/image's old `/^https?:\/\//i` test — one has no host at all — and both
  // are now rejected. Revert manga-routes.mjs to that regex and this test fails while /proxy's
  // stays green, which is exactly the divergence the shared module exists to prevent.
  for (const ref of ['https://', 'http://[nonsense']) {
    const res = await fetch(`${base}/manga/image?url=${q('https://1.1.1.1/p.jpg')}&ref=${q(ref)}`);
    const json = safeJson(await res.text());
    assert.equal(res.status, 400, `${ref} → ${res.status}`);
    assert.match(json.error, /'ref' must be an http\(s\) url/, ref);
  }
  // …and the ONE behaviour that route's own suite pins is untouched: it strips CR/LF and accepts
  // the remainder, rather than 400ing the way /proxy now does. (See the note in manga-routes.mjs:
  // rejecting is the better order; converging needs a change to a test this item does not own.)
  const stripped = await fetch(
    `${base}/manga/image?url=${q('https://1.1.1.1/p.jpg')}&ref=${q('https://mangapill.com/\r\nX-Injected: yes')}`
  );
  assert.notEqual(stripped.status, 400, 'the stripped form must still be accepted by /manga/image');
  await stripped.arrayBuffer();
});

// ------------------------------------------------------------------------------- no side channels

test('none of these params can be used to reach a loopback service', async () => {
  const before = canaryHits;
  for (const qs of [
    `url=${q(TARGET)}&ref=${q(canaryUrl)}`,
    `url=${q(TARGET)}&org=${q(new URL(canaryUrl).origin)}`,
    `url=${q(canaryUrl)}`,
  ]) {
    const { text } = await proxy(qs);
    assert.ok(!text.includes('SECRET-CANARY-BODY'), `canary body leaked: ${qs}`);
  }
  // ref/org are header values, never fetched; url is SSRF-blocked. Nothing may touch the canary.
  assert.equal(canaryHits, before, 'a /proxy param reached the internal service');
});

// ------------------------------------------------- the two transports must refuse the SAME values

test('a header value above U+00FF is refused, because only ONE transport refuses it on its own', async () => {
  // FOUND BY DRIVING THE WIRE, not by reading the code. /proxy was pointed at a raw TCP listener
  // (no HTTP parser in the way) with CURL_IMPERSONATE_BIN set to a real curl 8.7.1. U+2028 and
  // U+2029 are neither C0 controls nor DEL, so the original hasControlChar() check let them past
  // and `new URL()` happily keeps them in a path. The two transports then disagreed:
  //   plain fetch  -> 502  (undici: "Cannot convert argument to a ByteString ... value of 8232")
  //   curl argv    -> 200, and the bytes `Referer: https://a.example/<e2 80 a8>X-Injected: pwned`
  //                   went upstream verbatim — spawn() encodes argv as UTF-8 and applies no
  //                   ByteString rule at all.
  // Still ONE Referer line and no CR/LF in the capture, so this was never injection. It is the
  // other half of what this item is for: a value that reaches upstream malformed, and a silent
  // divergence between the two paths. 400 is the honest answer on both.
  for (const ch of ['\u2028', '\u2029', '\u00a0\u3000', '\ud83d\ude00']) {
    const ref = `https://a.example/${ch}X`;
    const { res, json } = await proxy(`url=${q(TARGET)}&ref=${q(ref)}`);
    assert.equal(res.status, 400, `${JSON.stringify(ch)} → ${res.status}`);
    assert.match(json.error, /'ref' must be an http\(s\) url/);
    assert.deepEqual(curlInvocations(), [], 'a non-ByteString value reached the upstream stand-in');
  }
});

test('the ByteString bound is 0xFF, not ASCII — a Latin-1 referer is still sent', async () => {
  // Deliberately NOT tightened to ASCII. `é` is a legal ByteString, undici sends it today, and
  // narrowing to ASCII would be a behaviour change dressed up as a fix rather than the
  // convergence this is. The bar is exactly "what the stricter transport already accepts".
  const ref = 'https://a.example/caf\u00e9';
  const { res, argv } = await proxy(`url=${q(TARGET)}&ref=${q(ref)}`);
  assert.equal(res.status, 200);
  assert.ok(argv, 'the argv path was not exercised');
  assert.equal(headerMap(argv).referer, ref);
});

test('org and km were already immune to the same class, so only ref needed the fix', async () => {
  // Worth pinning because it is the reason this was easy to miss: originHeaderValue rejects
  // U+2028/U+2029 incidentally (JS `\s` matches both) and isHeaderToken restricts to
  // [\x21-\x7e]. `ref` was the only one of the three whose check was written from scratch.
  for (const [param, value] of [
    ['org', 'https://a.example\u2028X'],
    ['km', 'abc\u2028X'],
  ]) {
    const { res } = await proxy(`url=${q(TARGET)}&${param}=${q(value)}`);
    assert.equal(res.status, 400, `${param} → ${res.status}`);
    assert.deepEqual(curlInvocations(), []);
  }
});
