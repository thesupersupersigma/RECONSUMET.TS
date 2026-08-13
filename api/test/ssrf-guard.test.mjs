// Unit tests for the /proxy + /watch SSRF guard (H1/M2).
//
// Hermetic on purpose: every resolver-dependent case injects `lookup`, and the two cases that do
// use the real resolver (`localhost`, and the decimal-integer host form) are answered by the OS
// from /etc/hosts / getaddrinfo without a network round-trip. So this suite is a real regression
// gate that runs offline — there is no live deployment to test against.
//
// Run: cd api && node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, assertUrlSafe, followSafeRedirects, SsrfError } from '../src/ssrf-guard.mjs';

// ---------------------------------------------------------------- isBlockedIp: the range table

const BLOCKED = [
  // the one that matters most: cloud instance metadata (AWS/GCP/Azure/DO all use 169.254.169.254)
  ['169.254.169.254', 'AWS/GCP/Azure IMDS'],
  ['169.254.0.1', 'link-local'],
  ['fd00:ec2::254', 'AWS IPv6 IMDS (unique-local)'],
  ['127.0.0.1', 'loopback'],
  ['127.1.2.3', 'loopback (whole /8)'],
  ['0.0.0.0', 'this-host'],
  ['0.1.2.3', '0.0.0.0/8'],
  ['10.0.0.1', 'RFC1918 10/8'],
  ['172.16.0.1', 'RFC1918 172.16/12 low edge'],
  ['172.31.255.255', 'RFC1918 172.16/12 high edge'],
  ['192.168.1.1', 'RFC1918 192.168/16'],
  ['100.64.0.1', 'CGNAT'],
  ['192.0.0.1', 'IETF protocol assignments'],
  ['192.0.2.5', 'TEST-NET-1'],
  ['198.18.0.1', 'benchmarking'],
  ['198.51.100.5', 'TEST-NET-2'],
  ['203.0.113.5', 'TEST-NET-3'],
  ['224.0.0.1', 'multicast'],
  ['240.0.0.1', 'reserved'],
  ['255.255.255.255', 'broadcast'],
  ['::1', 'IPv6 loopback'],
  ['::', 'IPv6 unspecified'],
  ['fc00::1', 'unique-local'],
  ['fe80::1', 'IPv6 link-local'],
  ['2001:db8::1', 'documentation'],
  ['100::1', 'discard-only'],
  // IPv4-mapped / NAT64 evasions — a v4 metadata address smuggled in as v6
  ['::ffff:127.0.0.1', 'IPv4-mapped loopback (dotted)'],
  ['::ffff:169.254.169.254', 'IPv4-mapped IMDS (dotted)'],
  ['::ffff:a9fe:a9fe', 'IPv4-mapped IMDS (hex)'],
  ['64:ff9b::a9fe:a9fe', 'NAT64-embedded IMDS'],
];

const ALLOWED = [
  ['1.1.1.1', 'Cloudflare DNS'],
  ['8.8.8.8', 'Google DNS'],
  ['93.184.216.34', 'example.com'],
  ['11.0.0.1', 'just outside 10/8'],
  ['172.15.0.1', 'just below 172.16/12'],
  ['172.32.0.1', 'just above 172.16/12'],
  ['100.63.255.255', 'just below CGNAT'],
  ['100.128.0.1', 'just above CGNAT'],
  ['192.169.0.1', 'just above 192.168/16'],
  ['2606:4700:4700::1111', 'Cloudflare DNS v6'],
  ['2001:4860:4860::8888', 'Google DNS v6'],
];

test('isBlockedIp blocks every private/loopback/link-local/metadata/reserved range', () => {
  for (const [ip, why] of BLOCKED) assert.equal(isBlockedIp(ip), true, `${ip} (${why}) must be blocked`);
});

test('isBlockedIp still permits ordinary public addresses', () => {
  for (const [ip, why] of ALLOWED) assert.equal(isBlockedIp(ip), false, `${ip} (${why}) must be allowed`);
});

test('isBlockedIp treats anything that is not a parseable IP as blocked (fail closed)', () => {
  for (const junk of ['', 'example.com', '999.999.999.999', '1.2.3', 'not-an-ip', '::gg'])
    assert.equal(isBlockedIp(junk), true, `${JSON.stringify(junk)} must fail closed`);
});

// ---------------------------------------------------------------- assertUrlSafe: scheme + host

test('assertUrlSafe rejects non-http(s) schemes', async () => {
  for (const url of ['file:///etc/passwd', 'gopher://127.0.0.1:11211/_stats', 'ftp://example.com/x', 'data:text/plain,hi'])
    await assert.rejects(assertUrlSafe(url), e => e instanceof SsrfError && /not allowed/.test(e.message), url);
});

test('assertUrlSafe rejects malformed urls', async () => {
  for (const url of ['', 'not a url', 'http://', '///nope'])
    await assert.rejects(assertUrlSafe(url), e => e instanceof SsrfError, JSON.stringify(url));
});

test('assertUrlSafe rejects literal-IP hosts in blocked ranges (incl. bracketed IPv6)', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.169.254:80/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:4000/',
    'http://10.0.0.5/internal',
    'http://[::1]:4000/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'https://[::ffff:169.254.169.254]/',
    // credentials-in-userinfo trick: the real host is still the metadata address
    'http://example.com@169.254.169.254/',
  ])
    await assert.rejects(assertUrlSafe(url), e => e instanceof SsrfError && /blocked/.test(e.message), url);
});

test('assertUrlSafe permits public literal IPs and returns the vetted address', async () => {
  assert.deepEqual(await assertUrlSafe('https://1.1.1.1/path?q=1'), ['1.1.1.1']);
  assert.deepEqual(await assertUrlSafe('http://93.184.216.34:8080/'), ['93.184.216.34']);
});

// Uses the OS resolver, but answered locally (hosts file / getaddrinfo numeric parsing) — no network.
test('assertUrlSafe blocks names and non-dotted forms the OS resolves to a blocked address', async () => {
  await assert.rejects(assertUrlSafe('http://localhost:4000/'), e => e instanceof SsrfError && /blocked/.test(e.message));
  // 2130706433 === 127.0.0.1, 0177.0.0.1 === octal 127.0.0.1: getaddrinfo accepts both, so the
  // check must happen on the RESOLVED address, not on the textual host.
  await assert.rejects(assertUrlSafe('http://2130706433/'), e => e instanceof SsrfError && /blocked/.test(e.message));
  await assert.rejects(assertUrlSafe('http://0177.0.0.1/'), e => e instanceof SsrfError && /blocked/.test(e.message));
});

// ---------------------------------------------------------------- assertUrlSafe: resolver branches

const fakeLookup = addresses => async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));

test('assertUrlSafe permits a hostname that resolves only to public addresses', async () => {
  const vetted = await assertUrlSafe('https://cdn.example.com/master.m3u8', {
    lookup: fakeLookup(['93.184.216.34', '2606:4700:4700::1111']),
  });
  assert.deepEqual(vetted, ['93.184.216.34', '2606:4700:4700::1111']);
});

test('assertUrlSafe rejects a hostname resolving to a private address (DNS-based SSRF)', async () => {
  await assert.rejects(
    assertUrlSafe('http://169-254-169-254.nip.io/latest/meta-data/', { lookup: fakeLookup(['169.254.169.254']) }),
    e => e instanceof SsrfError && /resolves to 169\.254\.169\.254/.test(e.message)
  );
});

test('assertUrlSafe rejects when ANY record is private, even if a public one is listed first', async () => {
  await assert.rejects(
    assertUrlSafe('http://split-horizon.example/', { lookup: fakeLookup(['93.184.216.34', '127.0.0.1']) }),
    e => e instanceof SsrfError && /127\.0\.0\.1/.test(e.message)
  );
  await assert.rejects(
    assertUrlSafe('http://split-horizon.example/', { lookup: fakeLookup(['93.184.216.34', '::1']) }),
    e => e instanceof SsrfError
  );
});

test('assertUrlSafe fails closed when resolution fails or yields nothing', async () => {
  await assert.rejects(
    assertUrlSafe('http://metadata.google.internal/', { lookup: async () => { throw new Error('ENOTFOUND'); } }),
    e => e instanceof SsrfError && /could not resolve/.test(e.message)
  );
  await assert.rejects(
    assertUrlSafe('http://void.example/', { lookup: fakeLookup([]) }),
    e => e instanceof SsrfError && /no addresses/.test(e.message)
  );
});

// ---------------------------------------------------------------- followSafeRedirects: per-hop re-validation

/** records every url fetchImpl is called with, replying from a scripted map of url → Response */
const scriptedFetch = script => {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const res = script[url];
    if (!res) throw new Error(`unscripted fetch: ${url}`);
    return typeof res === 'function' ? res() : res;
  };
  return { impl, calls };
};

const redirectTo = location => () => new Response(null, { status: 302, headers: { location } });

test('followSafeRedirects re-validates each hop and refuses a redirect into a blocked range', async () => {
  // The exploit shape: a perfectly public URL that 302s to cloud metadata.
  const { impl, calls } = scriptedFetch({
    'https://1.1.1.1/start': redirectTo('http://169.254.169.254/latest/meta-data/'),
  });
  await assert.rejects(
    followSafeRedirects('https://1.1.1.1/start', {}, { fetchImpl: impl }),
    e => e instanceof SsrfError && /169\.254\.169\.254/.test(e.message)
  );
  // the decisive assertion: the metadata endpoint was never actually requested
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://1.1.1.1/start');
});

test('followSafeRedirects blocks a private redirect target reached via a hostname', async () => {
  const { impl, calls } = scriptedFetch({ 'https://1.1.1.1/start': redirectTo('http://internal.example/admin') });
  await assert.rejects(
    followSafeRedirects('https://1.1.1.1/start', {}, { fetchImpl: impl, lookup: fakeLookup(['10.1.2.3']) }),
    e => e instanceof SsrfError && /10\.1\.2\.3/.test(e.message)
  );
  assert.equal(calls.length, 1);
});

test('followSafeRedirects follows a redirect that stays public, including a relative Location', async () => {
  const { impl, calls } = scriptedFetch({
    'https://1.1.1.1/start': redirectTo('/next'),
    'https://1.1.1.1/next': () => new Response('final body', { status: 200 }),
  });
  const res = await followSafeRedirects('https://1.1.1.1/start', {}, { fetchImpl: impl });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'final body');
  assert.deepEqual(calls.map(c => c.url), ['https://1.1.1.1/start', 'https://1.1.1.1/next']);
});

test('followSafeRedirects always fetches with redirect:manual and forwards caller options', async () => {
  const { impl, calls } = scriptedFetch({ 'https://1.1.1.1/x': () => new Response('ok', { status: 200 }) });
  await followSafeRedirects('https://1.1.1.1/x', { headers: { Referer: 'https://kwik.cx/' } }, { fetchImpl: impl });
  assert.equal(calls[0].opts.redirect, 'manual');
  assert.equal(calls[0].opts.headers.Referer, 'https://kwik.cx/');
});

test('followSafeRedirects caps the redirect chain instead of looping forever', async () => {
  const { impl, calls } = scriptedFetch({ 'https://1.1.1.1/loop': redirectTo('https://1.1.1.1/loop') });
  await assert.rejects(
    followSafeRedirects('https://1.1.1.1/loop', {}, { fetchImpl: impl, maxRedirects: 3 }),
    e => e instanceof SsrfError && /exceeded 3 redirects/.test(e.message)
  );
  assert.equal(calls.length, 4); // initial + 3 followed hops, then refuse
});

test('followSafeRedirects returns a 3xx that carries no Location rather than hanging', async () => {
  const { impl } = scriptedFetch({ 'https://1.1.1.1/x': () => new Response(null, { status: 304 }) });
  const res = await followSafeRedirects('https://1.1.1.1/x', {}, { fetchImpl: impl });
  assert.equal(res.status, 304);
});

test('followSafeRedirects refuses a redirect to a non-http scheme', async () => {
  const { impl, calls } = scriptedFetch({ 'https://1.1.1.1/x': redirectTo('file:///etc/passwd') });
  await assert.rejects(
    followSafeRedirects('https://1.1.1.1/x', {}, { fetchImpl: impl }),
    e => e instanceof SsrfError && /not allowed/.test(e.message)
  );
  assert.equal(calls.length, 1);
});
