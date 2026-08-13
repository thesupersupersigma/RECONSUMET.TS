// Nova extractor — what happens when the hardcoded AES key stops working.
//
// WHAT THIS PROTECTS. Nova decrypts /api/v1/video with a key/IV hardcoded in the extractor. That
// class of value rotates: Mkissa's static envelope key rotated TWICE in a single working session,
// with a scheduled switchAt two days out. Nova's key cannot be sourced live (its bundle is
// content-hashed and string-table-mangled — see the comment in src/extractors/nova.ts), so the
// mitigation is diagnosis: when it stops working the error has to say so in as many words, instead
// of surfacing as an OpenSSL padding complaint or, worse, an empty result.
//
// Offline: a fake axios adapter serves the ciphertext, so the tests can rotate the key at will.
// A LIVE check was not possible — AnimeNoSub is the only consumer of this extractor and its TLS
// handshake is blocked on this network, so no real video id could be obtained.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCipheriv } from 'node:crypto';

const require = createRequire(import.meta.url);
const mod = require('../dist/extractors/nova.js');
const Nova = mod.default ?? mod;

// the values the extractor ships with
const KEY = Buffer.from('kiemtienmua911ca');
const IV = Buffer.from('1234567890oiuytr');
const MASTER_URL = 'https://cf-cdn.example/cf-master.123.txt';
const MASTER_BODY = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nv1080.m3u8\n';
const PAYLOAD = JSON.stringify({ cf: MASTER_URL });

/** encrypt like Nova's API does: AES-128-CBC, hex */
const encrypt = (plaintext, key = KEY, iv = IV) => {
  const c = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]).toString('hex');
};

const fakeAdapter = routes => async config => {
  const url = `${config.url}${config.params ? `?${new URLSearchParams(config.params)}` : ''}`;
  const hit = Object.keys(routes)
    .filter(k => url.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (hit === undefined) throw new Error(`ECONNREFUSED ${url}`);
  return { data: routes[hit], status: 200, statusText: 'OK', headers: {}, config };
};

const novaWith = (videoBody, { key, iv } = {}) => {
  const n = new Nova();
  n.client.defaults.adapter = fakeAdapter({
    '/api/v1/video?id=': videoBody,
    [MASTER_URL]: MASTER_BODY,
  });
  if (key) n.key = key; // simulate the shipped key being wrong
  if (iv) n.iv = iv;
  return n;
};

const EMBED = new URL('https://nova.upn.one/#abc123');

describe('Nova decrypts with the shipped key', () => {
  test('a correctly-encrypted payload yields the master playlist', async () => {
    const src = await novaWith(encrypt(PAYLOAD)).extract(EMBED);
    assert.equal(src.sources[0].url, MASTER_URL);
    assert.equal(src.sources[0].isM3U8, true);
    assert.deepEqual(src.subtitles, []); // Nova is hardsubbed — no soft tracks by design
  });

  test('the per-quality variants are expanded from the master', async () => {
    const src = await novaWith(encrypt(PAYLOAD)).extract(EMBED);
    assert.ok(
      src.sources.some(s => s.quality === '1080p'),
      `expected a 1080p variant, got ${JSON.stringify(src.sources.map(s => s.quality))}`
    );
  });
});

describe('Nova says so when the key stops working', () => {
  // The whole point: each of these must name the rotation, not just fail.
  const expectsRotationDiagnosis = err => {
    assert.match(err.message, /rotated it/i, 'must say the key rotated');
    assert.match(err.message, /kiemtienmua911ca/, 'must name the key in use');
    assert.match(err.message, /1234567890oiuytr/, 'must name the iv in use');
    assert.match(err.message, /assets\/index-<hash>\.js/, 'must say where to re-derive it');
    assert.match(err.message, /src\/extractors\/nova\.ts/, 'must say what to update');
    return true;
  };

  test('the site rotates its key: ciphertext no longer decrypts', async () => {
    const rotated = encrypt(PAYLOAD, Buffer.from('ROTATEDkey123456'), Buffer.from('ROTATEDiv1234567'));
    await assert.rejects(novaWith(rotated).extract(EMBED), expectsRotationDiagnosis);
  });

  test('our key is wrong / stale: same diagnosis', async () => {
    // TASK2's check, from the other side — deliberately corrupt the key we hold.
    await assert.rejects(
      novaWith(encrypt(PAYLOAD), { key: Buffer.from('wrongkeywrongkey') }).extract(EMBED),
      expectsRotationDiagnosis
    );
  });

  test('a wrong key whose padding happens to validate is caught by the JSON check', async () => {
    // ~1/256 of wrong keys decrypt to a valid-padding, meaningless plaintext. Encrypting non-JSON
    // with the RIGHT key reproduces that end state deterministically.
    await assert.rejects(novaWith(encrypt('this is not json at all, it is noise')).extract(EMBED), err => {
      expectsRotationDiagnosis(err);
      assert.match(err.message, /not JSON/, 'must say the plaintext was not JSON');
      return true;
    });
  });
});

describe('Nova distinguishes a changed API from a rotated key', () => {
  test('a plain-JSON error body is reported as itself, not as a crypto failure', async () => {
    // What the live API actually answers for an unknown id — previously this decoded to an empty
    // buffer and surfaced as an unrelated OpenSSL "wrong final block length".
    await assert.rejects(novaWith('{"message": "Video not found or deleted"}').extract(EMBED), err => {
      assert.match(err.message, /did not return an AES hex blob/);
      assert.match(err.message, /Video not found or deleted/, 'must quote what came back instead');
      assert.doesNotMatch(err.message, /rotated it/i, 'must NOT blame the key');
      return true;
    });
  });

  test('an HTML interstitial or empty body is reported as itself too', async () => {
    for (const body of ['<html><body>Just a moment…</body></html>', '', '   ']) {
      await assert.rejects(novaWith(body).extract(EMBED), /did not return an AES hex blob/);
    }
  });

  test('a truncated hex blob is caught before decryption', async () => {
    const truncated = encrypt(PAYLOAD).slice(0, -8); // no longer a whole number of AES blocks
    await assert.rejects(novaWith(truncated).extract(EMBED), /did not return an AES hex blob/);
  });
});

describe('Nova never degrades silently', () => {
  test('no failure mode returns an empty source list instead of throwing', async () => {
    const bodies = [
      '{"message": "Video not found or deleted"}',
      '<html>nope</html>',
      '',
      encrypt(PAYLOAD, Buffer.from('ROTATEDkey123456'), Buffer.from('ROTATEDiv1234567')),
      encrypt('not json'),
      encrypt(JSON.stringify({ nothing: 'useful' })), // decrypts fine, but carries no playlist
    ];
    for (const body of bodies) {
      let result;
      try {
        result = await novaWith(body).extract(EMBED);
      } catch {
        continue; // threw — correct
      }
      assert.fail(`silently returned ${JSON.stringify(result)} for body ${JSON.stringify(body.slice(0, 40))}`);
    }
  });
});
