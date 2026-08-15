// A 429 IS NOT "NO MAPPING" — the cross-reference layer's caches must not confuse the two.
//
// THE BUG THIS PINS. `manga-xref.ts` declared `TTL_ERROR_MS = 30 * 1000` and then referenced it
// NOWHERE. Every cache in the file chose its TTL from the *value* alone:
//
//     new TtlCache(v => (v ? TTL_HIT_MS : TTL_MISS_MS))
//
// and every failure path — HTTP 429, 5xx, 403, a timeout, a refused connection — degraded to the
// same falsy value a genuine "upstream looked and there is nothing here" produces (`null` for
// MAL-Sync/MangaDex, `[]` for the alias resolver). So a single rate-limited request was written
// into the cache as though MAL-Sync had asserted "this series has no mapping", and served as that
// assertion for TTL_MISS_MS = TEN MINUTES.
//
// WHY tsc CANNOT SEE THIS. An unused `const` that *should* have been used is not a type error;
// the build gate passes at its usual 12 errors with the bug fully present. A test is the only
// instrument that detects it, so this file is the fix's only real proof.
//
// WHAT IS ASSERTED, and the pairing is the whole design:
//
//   * A GENUINE 404 is a durable fact — cached for TTL_MISS_MS, and a second call inside that
//     window issues NO second request. (Control: unchanged by the fix; it must keep passing.)
//   * A 429 is not a fact about the data at all — cached only for TTL_ERROR_MS, so the very next
//     fan-out after that short window reaches upstream and gets the REAL mapping.
//   * The difference is VISIBLE to the caller, not merely shorter-lived: `*Result()` carries a
//     typed `fault`, so "MAL-Sync says no such mapping" (`fault === null`) and "MAL-Sync refused
//     to answer" (`fault.kind === 'rate-limited'`) are different values, not the same `null`.
//   * A fault ANYWHERE on MangaDexXref's path propagates: if MAL-Sync 429s, its candidate UUIDs
//     never reach the batch verifier, so a subsequent empty title search is not evidence that no
//     MangaDex record exists.
//   * The old log line ("treating as \"no mapping\"") asserted exactly the thing it did not know.
//
// Offline: every HTTP call is served by a scripted fake axios adapter. Time is a patched
// `Date.now` so TTL boundaries are crossed in microseconds; nothing here sleeps.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axios = require('axios');
const xrefMod = require('../dist/providers/meta/manga-xref.js');

const { MalSyncIndex, MangaDexXref, MangaAliasResolver } = xrefMod;

// TTLs are module-private in the source; mirrored here so a boundary change breaks this file
// loudly rather than silently loosening what it proves.
const TTL_ERROR_MS = 30 * 1000;
const TTL_MISS_MS = 10 * 60 * 1000;

// =============================================================================================
// HARNESS
// =============================================================================================

/** A virtual clock. TtlCache reads `Date.now()` on every get, so patching it is sufficient. */
const realDateNow = Date.now;
let clockOffset = 0;
Date.now = () => realDateNow.call(Date) + clockOffset;
const advance = ms => {
  clockOffset += ms;
};
const resetClock = () => {
  clockOffset = 0;
};

/**
 * An axios adapter over {url-substring → step | step[]}, matched on the FULLY SERIALISED uri by
 * longest substring. A step array is consumed in order and the LAST step repeats forever — which
 * is what lets one route be "429 first, then healthy", the exact sequence this file is about.
 *
 * A step is `{status, data}` or `{throw: Error}`. An unmatched url rejects, the way a dead host
 * does, so a test can never silently pass by hitting a route it forgot to declare.
 */
const scriptedAdapter = script => {
  const seen = [];
  const cursor = new Map();
  const adapter = async config => {
    const url = axios.getUri(config);
    seen.push(url);
    const key = Object.keys(script)
      .filter(k => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) {
      const err = new Error(`ECONNREFUSED ${url}`);
      err.code = 'ECONNREFUSED';
      throw err;
    }
    const steps = Array.isArray(script[key]) ? script[key] : [script[key]];
    const n = cursor.get(key) ?? 0;
    cursor.set(key, n + 1);
    const step = steps[Math.min(n, steps.length - 1)];
    if (step && step.throw) throw step.throw;
    return { data: step.data, status: step.status ?? 200, statusText: '', headers: {}, config };
  };
  adapter.seen = seen;
  adapter.countFor = fragment => seen.filter(u => u.includes(fragment)).length;
  return adapter;
};

const clientFor = script => {
  const adapter = scriptedAdapter(script);
  return { client: axios.create({ adapter }), adapter };
};

/** Swallow (and return) console output so the suite stays readable and log text is assertable. */
const captureConsole = async fn => {
  const lines = [];
  const { warn, error } = console;
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    console.warn = warn;
    console.error = error;
  }
};

// =============================================================================================
// FIXTURES — trimmed real shapes, captured 2026-08-14.
// =============================================================================================

const MALSYNC_ONE_PIECE = {
  id: 13,
  title: 'One Piece',
  type: 'manga',
  Sites: {
    Mangadex: {
      'a1c7c817-4e59-43b7-9365-09675a149a6f': {
        identifier: 'a1c7c817-4e59-43b7-9365-09675a149a6f',
        title: 'One Piece',
        aniId: 30013,
        malId: 13,
        page: 'Mangadex',
      },
    },
    MangaFox: {
      one_piece: { identifier: 'one_piece', title: 'One Piece', aniId: 30013, malId: 13, page: 'MangaFox' },
    },
  },
};

/** Only the base record carries `links.al` — the one comparison MangaDexXref exists for. */
const MANGADEX_ONE_PIECE_BATCH = {
  result: 'ok',
  data: [
    {
      id: 'a1c7c817-4e59-43b7-9365-09675a149a6f',
      attributes: {
        title: { 'ja-ro': 'One Piece' },
        altTitles: [{ en: 'One Piece' }],
        links: { al: '30013', mal: '13' },
        year: 1997,
        originalLanguage: 'ja',
      },
    },
  ],
};

const MANGADEX_EMPTY = { result: 'ok', data: [] };

const ONE_PIECE_META = { anilistId: '30013', titles: ['One Piece'], malId: 13 };

const ANILIST_DEMON_SLAYER = {
  data: {
    Page: {
      media: [
        {
          id: 87216,
          idMal: 96792,
          popularity: 208719,
          title: { romaji: 'Kimetsu no Yaiba', english: 'Demon Slayer: Kimetsu no Yaiba', native: '鬼滅の刃' },
          synonyms: [],
        },
      ],
    },
  },
};

const ANILIST_NO_MATCHES = { data: { Page: { media: [] } } };

/** AniList's throttle: HTTP 200, `data: null`, a populated errors[]. Not "no such series". */
const ANILIST_THROTTLED = { data: null, errors: [{ message: 'Too Many Requests', status: 429 }] };

const MALSYNC_13 = 'api.malsync.moe/mal/manga/13';
const MALSYNC_MISSING = 'api.malsync.moe/mal/manga/99999999';
const MD_BATCH = 'api.mangadex.org/manga?ids';
const MD_TITLE = 'api.mangadex.org/manga?';
const ANILIST = 'graphql.anilist.co';

// =============================================================================================

describe('manga-xref: an upstream refusal is not a "no mapping" fact', () => {
  // ---------------------------------------------------------------------------------------
  // THE HEADLINE PAIR. Same class, same key shape, same falsy value — opposite cache lifetimes.
  // ---------------------------------------------------------------------------------------

  test('MalSyncIndex: a 429 then a healthy retry yields the REAL mapping, not a cached null', async () => {
    resetClock();
    const { client, adapter } = clientFor({
      [MALSYNC_13]: [{ status: 429, data: 'Too Many Requests' }, { status: 200, data: MALSYNC_ONE_PIECE }],
    });
    const index = new MalSyncIndex(client);

    await captureConsole(async () => {
      // 1. The refusal IS briefly cached — retrying a 429 immediately is the one response
      //    guaranteed to make a rate limit worse.
      const first = await index.lookupResult(13);
      assert.equal(first.value, null);
      assert.equal(first.fault?.kind, 'rate-limited', 'a 429 must be typed as a rate limit');
      assert.equal(first.fault?.source, 'malsync');
      assert.equal(first.fault?.status, 429);

      const inWindow = await index.lookupResult(13);
      assert.equal(adapter.countFor('/mal/manga/13'), 1, 'the 429 window must not re-hammer upstream');
      assert.equal(inWindow.fault?.kind, 'rate-limited');

      // 2. ...but it expires in TTL_ERROR_MS, NOT in TTL_MISS_MS. This is the bug: pre-fix the
      //    null was still cached here, ten minutes deep, and the real mapping was unreachable.
      advance(TTL_ERROR_MS + 1000);
      const retry = await index.lookupResult(13);
      assert.equal(adapter.countFor('/mal/manga/13'), 2, 'the error TTL must have expired by now');
      assert.equal(retry.fault, null, 'a successful retry is an answer, not a fault');
      assert.equal(retry.value?.id, 13);
      assert.ok(retry.value?.Sites?.MangaFox?.one_piece, 'the real mapping must come back');
    });
  });

  test('MalSyncIndex: the LEGACY lookup() surface recovers too — no *Result() call required', async () => {
    // Deliberately uses only the pre-existing signature, so this assertion is meaningful even
    // against a build where the new result methods do not exist at all.
    resetClock();
    const { client } = clientFor({
      [MALSYNC_13]: [{ status: 429, data: '' }, { status: 200, data: MALSYNC_ONE_PIECE }],
    });
    const index = new MalSyncIndex(client);

    await captureConsole(async () => {
      assert.equal(await index.lookup(13), null, '429 degrades to null, as it always did');
      advance(TTL_ERROR_MS + 1000);
      const after = await index.lookup(13);
      assert.ok(after, 'pre-fix this was still the cached null from the 429, for another 9.5 minutes');
      assert.equal(after.id, 13);
    });
  });

  test('MalSyncIndex: a genuine 404 IS a fact — cached for the full TTL_MISS_MS (control)', async () => {
    resetClock();
    const { client, adapter } = clientFor({
      [MALSYNC_MISSING]: [{ status: 404, data: '' }, { status: 200, data: MALSYNC_ONE_PIECE }],
    });
    const index = new MalSyncIndex(client);

    const first = await index.lookupResult(99999999);
    assert.equal(first.value, null);
    assert.equal(first.fault, null, 'a 404 is MAL-Sync answering, not refusing');

    await index.lookup(99999999);
    assert.equal(adapter.countFor('/mal/manga/99999999'), 1, 'a second call must be served from cache');

    // The discriminator: at the same instant a 429 would already have expired, a 404 has not.
    advance(TTL_ERROR_MS + 1000);
    assert.equal(await index.lookup(99999999), null);
    assert.equal(adapter.countFor('/mal/manga/99999999'), 1, 'a real absence must NOT expire in 30s');

    advance(TTL_MISS_MS);
    await index.lookup(99999999);
    assert.equal(adapter.countFor('/mal/manga/99999999'), 2, 'but it does expire eventually');
  });

  // ---------------------------------------------------------------------------------------
  // CLASSIFICATION — every non-200 that is not the documented "no mapping" answer, plus the
  // failure modes that never produce a status at all.
  // ---------------------------------------------------------------------------------------

  const timeout = Object.assign(new Error('timeout of 9000ms exceeded'), { code: 'ECONNABORTED' });
  const refused = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' });
  const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

  for (const [label, step, kind, status] of [
    ['429 rate limit', { status: 429, data: '' }, 'rate-limited', 429],
    ['500 server error', { status: 500, data: '' }, 'server-error', 500],
    ['502 bad gateway', { status: 502, data: '' }, 'server-error', 502],
    ['503 unavailable', { status: 503, data: '' }, 'server-error', 503],
    ['403 Cloudflare', { status: 403, data: '' }, 'unexpected-status', 403],
    ['400 bad request', { status: 400, data: '' }, 'unexpected-status', 400],
    ['request timeout', { throw: timeout }, 'transport', undefined],
    ['connection refused', { throw: refused }, 'transport', undefined],
    ['socket hang up', { throw: reset }, 'transport', undefined],
  ]) {
    test(`MalSyncIndex: ${label} is a fault, expires in TTL_ERROR_MS, and never claims "no mapping"`, async () => {
      resetClock();
      const { client, adapter } = clientFor({ [MALSYNC_13]: [step, { status: 200, data: MALSYNC_ONE_PIECE }] });
      const index = new MalSyncIndex(client);

      const { lines } = await captureConsole(async () => {
        const r = await index.lookupResult(13);
        assert.equal(r.value, null);
        assert.equal(r.fault?.kind, kind);
        assert.equal(r.fault?.status, status);
        assert.equal(r.fault?.source, 'malsync');
        assert.ok(r.fault?.detail, 'a fault must carry something loggable');

        advance(TTL_ERROR_MS + 1000);
        assert.equal((await index.lookupResult(13)).fault, null, 'the fault must not outlive its window');
        assert.equal(adapter.countFor('/mal/manga/13'), 2);
      });

      const logged = lines.join('\n');
      assert.ok(logged.length > 0, 'a refusal must be logged');
      assert.ok(
        !/treating as "?no mapping"?/i.test(logged),
        `the log must stop asserting what it does not know — got: ${logged}`
      );
      assert.ok(/UNKNOWN whether a mapping exists/.test(logged), `expected an honest log line — got: ${logged}`);
    });
  }

  test('MalSyncIndex: stats() counts faults separately from hits and misses', async () => {
    resetClock();
    const { client } = clientFor({
      [MALSYNC_13]: [{ status: 503, data: '' }, { status: 200, data: MALSYNC_ONE_PIECE }],
      [MALSYNC_MISSING]: { status: 404, data: '' },
    });
    const index = new MalSyncIndex(client);

    await captureConsole(async () => {
      await index.lookupResult(13); // fault
      await index.lookupResult(99999999); // genuine miss — NOT a fault
      assert.equal(index.stats().faults, 1, 'a 404 must not be counted as an outage');
      advance(TTL_ERROR_MS + 1000);
      await index.lookupResult(13); // recovers
      assert.equal(index.stats().faults, 1);
    });
  });

  // ---------------------------------------------------------------------------------------
  // MANGADEX XREF — the fault has to travel, because the strongest path was never walked.
  // ---------------------------------------------------------------------------------------

  test('MangaDexXref: MAL-Sync 429 poisons the whole path, so the null is NOT cached as a miss', async () => {
    resetClock();
    const { client, adapter } = clientFor({
      [MALSYNC_13]: [{ status: 429, data: '' }, { status: 200, data: MALSYNC_ONE_PIECE }],
      [MD_BATCH]: { status: 200, data: MANGADEX_ONE_PIECE_BATCH },
      // Title search genuinely finds nothing, so pre-fix this looked like a clean "no record".
      [MD_TITLE]: { status: 200, data: MANGADEX_EMPTY },
    });
    const xref = new MangaDexXref(client, new MalSyncIndex(client));

    await captureConsole(async () => {
      const first = await xref.resolveResult(ONE_PIECE_META);
      assert.equal(first.value, null);
      assert.equal(first.fault?.kind, 'rate-limited');
      assert.equal(first.fault?.source, 'malsync', 'the ORIGINAL cause must survive the fallback');
      assert.equal(adapter.countFor(MD_BATCH), 0, 'no candidates ever reached the verifier');

      advance(TTL_ERROR_MS + 1000);
      const retry = await xref.resolveResult(ONE_PIECE_META);
      assert.equal(retry.fault, null);
      assert.equal(retry.value?.id, 'a1c7c817-4e59-43b7-9365-09675a149a6f');
      assert.equal(retry.value?.matchedBy, 'malsync-then-links.al');

      // And through the legacy surface, which is what VerifiedMangaMetadataResolver calls.
      assert.equal((await xref.resolve(ONE_PIECE_META))?.id, 'a1c7c817-4e59-43b7-9365-09675a149a6f');
    });
  });

  test('MangaDexXref: a 503 on the ids[] verifier is a fault, not a verified absence', async () => {
    resetClock();
    const { client } = clientFor({
      [MALSYNC_13]: { status: 200, data: MALSYNC_ONE_PIECE },
      [MD_BATCH]: [{ status: 503, data: '' }, { status: 200, data: MANGADEX_ONE_PIECE_BATCH }],
      [MD_TITLE]: { status: 200, data: MANGADEX_EMPTY },
    });
    const xref = new MangaDexXref(client, new MalSyncIndex(client));

    await captureConsole(async () => {
      const first = await xref.resolveResult(ONE_PIECE_META);
      assert.equal(first.value, null);
      assert.equal(first.fault?.kind, 'server-error');
      assert.equal(first.fault?.source, 'mangadex');

      advance(TTL_ERROR_MS + 1000);
      const retry = await xref.resolveResult(ONE_PIECE_META);
      assert.equal(retry.fault, null);
      assert.equal(retry.value?.id, 'a1c7c817-4e59-43b7-9365-09675a149a6f');
    });
  });

  test('MangaDexXref: a 429 on every title probe is a fault (no MAL-Sync coverage at all)', async () => {
    resetClock();
    const { client } = clientFor({
      [MD_TITLE]: [{ status: 429, data: '' }, { status: 200, data: MANGADEX_ONE_PIECE_BATCH }],
    });
    // No MalSyncIndex: the title path is the only path, so its refusal is the only signal.
    const xref = new MangaDexXref(client);

    await captureConsole(async () => {
      const first = await xref.resolveResult({ anilistId: '30013', titles: ['One Piece'] });
      assert.equal(first.value, null);
      assert.equal(first.fault?.kind, 'rate-limited');
      assert.equal(first.fault?.source, 'mangadex');

      advance(TTL_ERROR_MS + 1000);
      const retry = await xref.resolveResult({ anilistId: '30013', titles: ['One Piece'] });
      assert.equal(retry.fault, null);
      assert.equal(retry.value?.matchedBy, 'title-search-then-links.al');
    });
  });

  test('MangaDexXref: a genuinely unmapped series stays cached for TTL_MISS_MS (control)', async () => {
    resetClock();
    const { client, adapter } = clientFor({
      [MALSYNC_MISSING]: { status: 404, data: '' },
      [MD_TITLE]: { status: 200, data: MANGADEX_EMPTY },
    });
    const xref = new MangaDexXref(client, new MalSyncIndex(client));
    const meta = { anilistId: '999999', titles: ['Definitely Not A Real Series'], malId: 99999999 };

    const first = await xref.resolveResult(meta);
    assert.equal(first.value, null);
    assert.equal(first.fault, null, 'every upstream answered; the absence is a fact');
    const requests = adapter.seen.length;

    advance(TTL_ERROR_MS + 1000);
    assert.equal(await xref.resolve(meta), null);
    assert.equal(adapter.seen.length, requests, 'a verified absence must NOT expire in 30s');
  });

  // ---------------------------------------------------------------------------------------
  // ALIAS RESOLVER — the hardest of the three: [] is BOTH a legitimate answer and the old
  // failure value, so before the fix nothing anywhere could tell them apart.
  // ---------------------------------------------------------------------------------------

  test('MangaAliasResolver: a 429 then a healthy retry yields the REAL candidates, not a cached []', async () => {
    resetClock();
    const { client, adapter } = clientFor({
      [ANILIST]: [{ status: 429, data: '' }, { status: 200, data: ANILIST_DEMON_SLAYER }],
    });
    const resolver = new MangaAliasResolver(client);

    await captureConsole(async () => {
      const first = await resolver.resolveResult('demon slayer');
      assert.deepEqual(first.value, [], 'the degraded value is still []');
      assert.equal(first.fault?.kind, 'rate-limited', 'but it is now distinguishable from a real []');
      assert.equal(first.fault?.source, 'anilist-alias');

      assert.deepEqual(await resolver.resolve('demon slayer'), []);
      assert.equal(adapter.countFor(ANILIST), 1, 'the error window still deduplicates');

      advance(TTL_ERROR_MS + 1000);
      const retry = await resolver.resolveResult('demon slayer');
      assert.equal(retry.fault, null);
      assert.equal(retry.value.length, 1);
      assert.equal(retry.value[0].anilistId, 87216);
      assert.equal(retry.value[0].malId, 96792);
    });
  });

  test('MangaAliasResolver: HTTP 200 WITH a GraphQL errors[] is a rate limit, not "no such series"', async () => {
    resetClock();
    const { client } = clientFor({
      [ANILIST]: [{ status: 200, data: ANILIST_THROTTLED }, { status: 200, data: ANILIST_DEMON_SLAYER }],
    });
    const resolver = new MangaAliasResolver(client);

    await captureConsole(async () => {
      const first = await resolver.resolveResult('demon slayer');
      assert.deepEqual(first.value, []);
      assert.equal(first.fault?.kind, 'rate-limited');
      assert.match(first.fault?.detail ?? '', /Too Many Requests/);

      advance(TTL_ERROR_MS + 1000);
      assert.equal((await resolver.resolveResult('demon slayer')).value.length, 1);
    });
  });

  test('MangaAliasResolver: a transport failure is a fault, and expires fast', async () => {
    resetClock();
    const dead = Object.assign(new Error('getaddrinfo EAI_AGAIN graphql.anilist.co'), { code: 'EAI_AGAIN' });
    const { client } = clientFor({ [ANILIST]: [{ throw: dead }, { status: 200, data: ANILIST_DEMON_SLAYER }] });
    const resolver = new MangaAliasResolver(client);

    await captureConsole(async () => {
      const first = await resolver.resolveResult('demon slayer');
      assert.equal(first.fault?.kind, 'transport');
      assert.equal(first.fault?.status, undefined);
      advance(TTL_ERROR_MS + 1000);
      assert.equal((await resolver.resolveResult('demon slayer')).fault, null);
    });
  });

  test('MangaAliasResolver: a genuinely empty result IS a fact and stays cached (control)', async () => {
    resetClock();
    const { client, adapter } = clientFor({
      [ANILIST]: [{ status: 200, data: ANILIST_NO_MATCHES }, { status: 200, data: ANILIST_DEMON_SLAYER }],
    });
    const resolver = new MangaAliasResolver(client);

    const first = await resolver.resolveResult('qwertzuiop not a manga');
    assert.deepEqual(first.value, []);
    assert.equal(first.fault, null, 'AniList answered; "nothing matches" is a real answer');
    assert.equal(resolver.stats().faults, 0);

    advance(TTL_ERROR_MS + 1000);
    assert.deepEqual(await resolver.resolve('qwertzuiop not a manga'), []);
    assert.equal(adapter.countFor(ANILIST), 1, 'a real empty result must NOT expire in 30s');

    advance(TTL_MISS_MS);
    await resolver.resolve('qwertzuiop not a manga');
    assert.equal(adapter.countFor(ANILIST), 2);
  });

  test('MangaAliasResolver: providerIdFor reports a MAL-Sync refusal instead of a silent null', async () => {
    resetClock();
    const { client } = clientFor({
      [MALSYNC_13]: [{ status: 429, data: '' }, { status: 200, data: MALSYNC_ONE_PIECE }],
    });
    const index = new MalSyncIndex(client);
    const resolver = new MangaAliasResolver(client, index);
    const candidate = { anilistId: 30013, malId: 13, popularity: 1, titles: ['One Piece'], similarity: 1 };

    const { lines } = await captureConsole(async () => {
      assert.equal(await resolver.providerIdFor(candidate, 'MangaHere'), null);
      advance(TTL_ERROR_MS + 1000);
      assert.equal(await resolver.providerIdFor(candidate, 'MangaHere'), 'one_piece');
    });
    assert.ok(
      /UNKNOWN whether MangaFox lists this series/.test(lines.join('\n')),
      `the alias bridge must say it does not know — got: ${lines.join('\n')}`
    );
  });

  // ---------------------------------------------------------------------------------------
  // In-flight deduplication is what makes a 30s error window safe rather than a stampede
  // guard, so it must survive the rewrite.
  // ---------------------------------------------------------------------------------------

  test('a concurrent fan-out over a rate-limited upstream still costs exactly ONE request', async () => {
    resetClock();
    const { client, adapter } = clientFor({ [MALSYNC_13]: { status: 429, data: '' } });
    const index = new MalSyncIndex(client);

    await captureConsole(async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => index.lookupResult(13)));
      assert.equal(adapter.countFor('/mal/manga/13'), 1);
      for (const r of results) assert.equal(r.fault?.kind, 'rate-limited');
    });
  });
});
