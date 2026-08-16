// A SKIPPED BRIDGE AND AN ANSWERED-EMPTY BRIDGE MUST NOT LOOK THE SAME TO A CALLER.
//
// THE GAP THIS PINS, and it is a gap in REACHABILITY, not in logic. The previous pass gave
// manga-xref.ts a real fault vocabulary — `IXrefFault`, `IXrefResult`, and a `*Result()` sibling
// beside every legacy lookup — and then nothing consumed it. `manga-metadata.ts` called
// `xref.resolve()` and `index.lookup()`, each of which is literally `(await …Result()).value`, so
// the fault was constructed, logged, used to pick a cache TTL, and discarded before any caller
// could see it. A consumer of `createMangaMetadataLayer` observed exactly one thing —
// a null id and an 'unverified' mapping — whether MAL-Sync had said "no such mapping" or had
// refused to say anything at all.
//
// That distinction is the single most expensive one in this project's history: an upstream failure
// indistinguishable from a legitimate empty result is why four fail-open providers (HTTP 200 +
// empty array — passes every health check) survived to Phase 3, and why the Mkissa outage took a
// 13-agent investigation.
//
// WHAT IS ASSERTED, and the pairing is the whole design:
//
//   * THE DEGRADED ANSWER IS IDENTICAL. Both bridges still return `null` under a 429. They do not
//     throw, and they do not guess. The aggregator treats a throwing bridge as "stay unverified"
//     precisely so a bug cannot manufacture confidence; a transient fault must land in the same
//     place, and these tests assert the null explicitly rather than only asserting the new signal.
//   * THE EXPLANATION IS DIFFERENT, and it is visible OUTSIDE the layer — through `layer.faults`
//     (pull, no pre-registration needed) and through an `onXrefFault` observer (push). Neither
//     inspects a private cache; both are the public surface of ./manga-metadata.ts.
//   * `Retry-After` IS OBEYED, in both legal forms, clamped at both ends. A 429 that names a
//     120-second window is cached for 120 seconds and not for the flat 30-second guess; a 24-hour
//     one is capped; a past date or a literal `0` is floored; an unparseable or absent one falls
//     back to the guess rather than to zero.
//
// WHY tsc CANNOT SEE ANY OF THIS. Calling `resolve()` where `resolveResult()` was wanted is
// perfectly typed — the legacy method exists and returns the declared type. The build gate reports
// its usual 12 errors with the whole gap present. A test is the only instrument.
//
// HONESTY ABOUT THE 429 ITSELF: nothing here confirms what MAL-Sync actually does under throttle.
// Its status code and whether it sends `Retry-After` at all are UNOBSERVED — this suite scripts an
// RFC 9110-conformant refusal and proves the layer handles it. It is not evidence about MAL-Sync.
//
// Offline: every HTTP call is served by a scripted fake axios adapter. Time is a patched
// `Date.now`, so TTL boundaries are crossed in microseconds; nothing here sleeps.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axios = require('axios');
const metaMod = require('../dist/providers/meta/manga-metadata.js');
const xrefMod = require('../dist/providers/meta/manga-xref.js');

const { createMangaMetadataLayer, MangaXrefFaultLog, describeMangaMetadataLayer } = metaMod;
const { parseRetryAfterMs, retryAfterFromHeaders } = xrefMod;

// Mirrored from the source, which keeps them module-private. A boundary change must break this
// file loudly rather than silently loosening what it proves.
const TTL_ERROR_MS = 30 * 1000;
const RETRY_AFTER_MIN_MS = 1000;
const RETRY_AFTER_MAX_MS = 5 * 60 * 1000;

// =============================================================================================
// HARNESS
// =============================================================================================

const realDateNow = Date.now;
let clockOffset = 0;
const advance = ms => {
  clockOffset += ms;
};

beforeEach(() => {
  clockOffset = 0;
  Date.now = () => realDateNow.call(Date) + clockOffset;
});
afterEach(() => {
  Date.now = realDateNow;
});

/**
 * An axios adapter over {url-substring → step | step[]}, matched on the FULLY SERIALISED uri by
 * longest substring. A step array is consumed in order and the LAST step repeats forever, which is
 * what lets one route be "429 first, then healthy".
 *
 * A step is `{status, data, headers}` or `{throw: Error}`. `headers` is what makes this file
 * possible at all — the pre-existing fault suite hardcodes `headers: {}`, so it could never have
 * exercised `Retry-After`. An unmatched url rejects the way a dead host does, so a test cannot
 * silently pass by hitting a route it forgot to declare.
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
    return { data: step.data, status: step.status ?? 200, statusText: '', headers: step.headers ?? {}, config };
  };
  adapter.seen = seen;
  adapter.countFor = fragment => seen.filter(u => u.includes(fragment)).length;
  return adapter;
};

/** Swallow console noise so the suite stays readable, and return the lines for assertion. */
const quiet = async fn => {
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

/** A base metadata resolver that never touches the network. AniList itself is not under test here. */
const stubBase = (meta = ONE_PIECE_META) => ({ resolve: async () => ({ ...meta }) });

/**
 * The layer as a real caller builds it, over a scripted client. `observed` is the PUSH channel;
 * `layer.faults` is the PULL channel. Both are asserted, because a caller that wired nothing in
 * advance must still be able to find out — requiring pre-registration would reproduce the original
 * problem in a new place.
 */
const layerFor = (script, { base = stubBase(), options = {} } = {}) => {
  const adapter = scriptedAdapter(script);
  const client = axios.create({ adapter });
  const observed = [];
  const layer = createMangaMetadataLayer(client, base, { ...options, onXrefFault: e => observed.push(e) });
  const [mangadexBridge, malsyncBridge] = layer.bridges;
  return { layer, adapter, client, observed, mangadexBridge, malsyncBridge };
};

// =============================================================================================
// FIXTURES — trimmed real shapes, captured 2026-08-14.
// =============================================================================================

const ONE_PIECE_META = { anilistId: '30013', titles: ['One Piece'], malId: 13 };

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

/** MAL-Sync's genuine "no mapping" answer: a clean 404. Verified live with malId 99999999. */
const MALSYNC_404 = { status: 404, data: { error: 'Not found' } };

/** MAL-Sync knows the series but lists NO MangaFox record — an answered, legitimate absence. */
const MALSYNC_NO_MANGAFOX = { id: 13, title: 'One Piece', Sites: { Mangadex: MALSYNC_ONE_PIECE.Sites.Mangadex } };

const MANGADEX_ONE_PIECE_BATCH = {
  result: 'ok',
  data: [
    {
      id: 'a1c7c817-4e59-43b7-9365-09675a149a6f',
      attributes: {
        title: { 'ja-ro': 'One Piece' },
        altTitles: [{ en: 'One Piece' }, { en: 'Wan Pisu' }],
        links: { al: '30013', mal: '13' },
        year: 1997,
        originalLanguage: 'ja',
      },
    },
  ],
};

const MANGADEX_EMPTY = { result: 'ok', data: [] };

const MALSYNC_13 = 'api.malsync.moe/mal/manga/13';
const MD_BATCH = 'api.mangadex.org/manga?ids';
const MD_TITLE = 'api.mangadex.org/manga?';

/** MangaDex answered honestly and found nothing — the control for every fault case below. */
const CLEAN_MANGADEX_MISS = { [MALSYNC_13]: MALSYNC_404, [MD_TITLE]: { status: 200, data: MANGADEX_EMPTY } };

// =============================================================================================
// THE HEADLINE PAIR — same answer, different explanation, both visible from outside the layer.
// =============================================================================================

describe('manga-metadata: a refused bridge and an empty bridge are distinguishable to a CALLER', () => {
  test('malsync bridge: a genuine 404 yields null and NO fault — the answer is a fact', async () => {
    const { layer, malsyncBridge, observed } = layerFor({ [MALSYNC_13]: MALSYNC_404 });

    const { result: id } = await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));

    assert.equal(id, null, 'MAL-Sync says there is no mapping; null is the correct answer');
    assert.equal(observed.length, 0, 'an answered "no mapping" is NOT a fault and must not be reported as one');
    assert.equal(layer.faults.total, 0);
    assert.deepEqual(layer.faults.summary().byKind, {});
  });

  test('malsync bridge: MAL-Sync listing the series but not the site is STILL not a fault', async () => {
    // The subtler control. MAL-Sync answered 200 and simply has no MangaFox record, which is a
    // durable fact about the data. If the fault channel fired here it would be crying wolf.
    const { layer, malsyncBridge, observed } = layerFor({
      [MALSYNC_13]: { status: 200, data: MALSYNC_NO_MANGAFOX },
    });

    const { result: id } = await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));

    assert.equal(id, null);
    assert.equal(observed.length, 0);
    assert.equal(layer.faults.total, 0);
  });

  test('malsync bridge: a 429 yields THE SAME null — but the caller can now see WHY', async () => {
    const { layer, malsyncBridge, observed } = layerFor({
      [MALSYNC_13]: { status: 429, data: 'Too Many Requests' },
    });

    const { result: id, lines } = await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));

    // (1) THE DEGRADED ANSWER IS UNCHANGED. This is not incidental — it is the safety property.
    //     The bridge must not throw (the aggregator would still stay unverified, but the log would
    //     misattribute), and it must certainly not invent an id.
    assert.equal(id, null, 'a transient fault must never fabricate confidence');

    // (2) THE PUSH CHANNEL saw it.
    assert.equal(observed.length, 1, 'exactly one fault, from the one refused lookup');
    const event = observed[0];
    assert.equal(event.stage, 'bridge');
    assert.equal(event.where, 'malsync');
    assert.equal(event.provider, 'MangaHere');
    assert.equal(event.anilistId, '30013');
    assert.equal(event.fault.kind, 'rate-limited');
    assert.equal(event.fault.source, 'malsync');
    assert.equal(event.fault.status, 429);

    // (3) THE PULL CHANNEL saw it too — no pre-registration required, which is the case that
    //     matters for a diagnostics endpoint and for anyone debugging after the fact.
    assert.equal(layer.faults.total, 1);
    assert.deepEqual(layer.faults.summary().byKind, { 'rate-limited': 1 });
    assert.deepEqual(layer.faults.summary().bySource, { malsync: 1 });
    assert.equal(layer.faults.forAnilistId(30013).length, 1, 'and it is attributable to the request');
    assert.equal(layer.faults.forAnilistId('999999').length, 0);

    // (4) The log line must not assert the thing it does not know.
    const line = lines.find(l => l.includes('malsync bridge SKIPPED'));
    assert.ok(line, `expected a SKIPPED log line, got: ${JSON.stringify(lines)}`);
    assert.match(line, /UNKNOWN whether/);
    assert.ok(!/no mapping exists/i.test(line));
  });

  test('the 404 and the 429 return the SAME value — proving the signal is the only difference', async () => {
    const miss = layerFor({ [MALSYNC_13]: MALSYNC_404 });
    const refused = layerFor({ [MALSYNC_13]: { status: 429, data: '' } });

    const { result: a } = await quiet(() => miss.malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));
    const { result: b } = await quiet(() => refused.malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));

    assert.deepEqual(a, b, 'identical return values — the fix adds a channel, it does not change the answer');
    assert.notDeepEqual(
      [miss.layer.faults.total, refused.layer.faults.total],
      [0, 0],
      'and yet the two are now distinguishable'
    );
    assert.equal(miss.layer.faults.total, 0);
    assert.equal(refused.layer.faults.total, 1);
  });

  test('a 5xx and a transport failure are reported with their own kinds, not lumped together', async () => {
    const boom = new Error('socket hang up');
    boom.code = 'ECONNRESET';

    const server = layerFor({ [MALSYNC_13]: { status: 503, data: 'bad gateway' } });
    const transport = layerFor({ [MALSYNC_13]: { throw: boom } });

    await quiet(() => server.malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));
    await quiet(() => transport.malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));

    assert.equal(server.observed[0].fault.kind, 'server-error');
    assert.equal(transport.observed[0].fault.kind, 'transport');
    assert.equal(transport.observed[0].fault.status, undefined, 'nothing was ever answered, so there is no status');
  });

  test('an uncovered provider still costs nothing and reports nothing — the free-registration invariant', async () => {
    const { layer, malsyncBridge, adapter } = layerFor({ [MALSYNC_13]: { status: 429, data: '' } });

    // MangaPill has no MAL-Sync binding at all; the bridge must bail before any request, so the
    // 429 route is never even reached and there is nothing to report.
    const id = await malsyncBridge.lookup(ONE_PIECE_META, 'MangaPill');

    assert.equal(id, null);
    assert.equal(adapter.seen.length, 0, 'no request for an uncovered provider');
    assert.equal(layer.faults.total, 0, 'and therefore no fault — "not covered" is not "refused"');
  });
});

// =============================================================================================
// THE SAME PROPERTY FOR THE OTHER TWO CONSUMERS IN THE FILE.
// =============================================================================================

describe('manga-metadata: the mangadex-links.al bridge and the resolver report faults too', () => {
  test('mangadex-links.al: an honest empty search is silent; a 429 anywhere on the path is not', async () => {
    const clean = layerFor(CLEAN_MANGADEX_MISS);
    const { result: cleanId } = await quiet(() => clean.mangadexBridge.lookup(ONE_PIECE_META, 'MangaDex'));
    assert.equal(cleanId, null);
    assert.equal(clean.layer.faults.total, 0, 'MangaDex looked and found nothing — a fact, not a fault');

    // A FAULT ANYWHERE ON THE PATH POISONS THE "NOT FOUND". MAL-Sync 429s, so its candidate UUIDs
    // never reach the batch verifier; the subsequent empty title search is therefore not evidence
    // that no MangaDex record exists, and the caller must be told that.
    const refused = layerFor({
      [MALSYNC_13]: { status: 429, data: '' },
      [MD_TITLE]: { status: 200, data: MANGADEX_EMPTY },
    });
    const { result: refusedId } = await quiet(() => refused.mangadexBridge.lookup(ONE_PIECE_META, 'MangaDex'));

    assert.equal(refusedId, null, 'still the same degraded answer');
    assert.equal(refused.layer.faults.total, 1);
    assert.equal(refused.observed[0].where, 'mangadex-links.al');
    assert.equal(refused.observed[0].provider, 'MangaDex');
    assert.equal(refused.observed[0].fault.kind, 'rate-limited');
    assert.equal(refused.observed[0].fault.source, 'malsync', 'attributed to the upstream that actually refused');
  });

  test('mangadex-links.al: a SUCCESSFUL bridge reports no fault and still returns the id', async () => {
    const { layer, mangadexBridge } = layerFor({
      [MALSYNC_13]: { status: 200, data: MALSYNC_ONE_PIECE },
      [MD_BATCH]: { status: 200, data: MANGADEX_ONE_PIECE_BATCH },
    });

    const { result: id } = await quiet(() => mangadexBridge.lookup(ONE_PIECE_META, 'MangaDex'));

    assert.equal(id, 'a1c7c817-4e59-43b7-9365-09675a149a6f');
    assert.equal(layer.faults.total, 0, 'an answer is an answer — no fault to report');
  });

  test('VerifiedMangaMetadataResolver: enrichment still degrades honestly, and says it degraded', async () => {
    const clean = layerFor(CLEAN_MANGADEX_MISS);
    const { result: cleanMeta } = await quiet(() => clean.layer.metadata.resolve('30013'));
    assert.deepEqual(cleanMeta.titles, ['One Piece'], 'nothing to enrich with');
    assert.equal(clean.layer.faults.total, 0);

    const refused = layerFor({
      [MALSYNC_13]: { status: 429, data: '' },
      [MD_TITLE]: { status: 200, data: MANGADEX_EMPTY },
    });
    const { result: refusedMeta } = await quiet(() => refused.layer.metadata.resolve('30013'));

    // The resolver's contract is unchanged: AniList-only metadata, never a throw. What is new is
    // that "we could not enrich" is no longer indistinguishable from "there was nothing to add".
    assert.deepEqual(refusedMeta.titles, ['One Piece']);
    assert.equal(refusedMeta.anilistId, '30013');
    assert.equal(refused.layer.faults.total, 1);
    assert.equal(refused.observed[0].stage, 'metadata');
    assert.equal(refused.observed[0].where, 'verified-metadata');
    assert.equal(refused.observed[0].provider, undefined, 'the resolver is not answering about a provider');
  });

  test('VerifiedMangaMetadataResolver: an AniList base-resolver THROW is reported and still rethrown', async () => {
    const boom = new Error('Request failed with status code 429');
    const { layer, observed } = layerFor(CLEAN_MANGADEX_MISS, {
      base: {
        resolve: async () => {
          throw boom;
        },
      },
    });

    // BEHAVIOUR IS UNCHANGED — AniListMangaMetadataResolver posts without `validateStatus`, so its
    // 429 throws out of the whole call, and this item does not alter that. It is merely no longer
    // invisible.
    await assert.rejects(() => quiet(() => layer.metadata.resolve('30013')), /429/);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].where, 'anilist-base-resolver');
    assert.equal(observed[0].fault.source, 'anilist-metadata');
    assert.equal(observed[0].fault.kind, 'transport');
  });

  test('a THROWING observer cannot downgrade a match — it is swallowed, not propagated', async () => {
    // A bridge that throws is caught by the aggregator and the candidate stays 'unverified'. So an
    // observer throwing would silently turn a diagnostics hook into a correctness regression.
    const adapter = scriptedAdapter({ [MALSYNC_13]: { status: 200, data: MALSYNC_ONE_PIECE } });
    const client = axios.create({ adapter });
    const layer = createMangaMetadataLayer(client, stubBase(), {
      onXrefFault: () => {
        throw new Error('observer is broken');
      },
    });
    const malsyncBridge = layer.bridges[1];

    // A refusal on a DIFFERENT route so the bridge path itself succeeds afterwards.
    const refusedAdapter = scriptedAdapter({ [MALSYNC_13]: { status: 429, data: '' } });
    const refusedLayer = createMangaMetadataLayer(axios.create({ adapter: refusedAdapter }), stubBase(), {
      onXrefFault: () => {
        throw new Error('observer is broken');
      },
    });

    const { result: id } = await quiet(() => refusedLayer.bridges[1].lookup(ONE_PIECE_META, 'MangaHere'));
    assert.equal(id, null, 'the observer blew up and the bridge still returned its normal answer');
    assert.equal(refusedLayer.faults.total, 1, 'and the pull channel recorded it regardless');

    // Sanity: the healthy layer still bridges.
    const { result: ok } = await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));
    assert.equal(ok, 'one_piece');
  });

  test('describeMangaMetadataLayer surfaces the live refusal picture beside the static coverage lists', async () => {
    const { layer, malsyncBridge } = layerFor({ [MALSYNC_13]: { status: 429, data: '' } });
    await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));

    // "A bridge did not fire" has two causes. The static lists cover the structural one; this
    // covers the transient one, which had no representation at all before this item.
    assert.equal(describeMangaMetadataLayer(undefined, undefined).xrefFaults, null);
    const described = describeMangaMetadataLayer(undefined, layer.faults);
    assert.equal(described.xrefFaults.total, 1);
    assert.deepEqual(described.xrefFaults.byKind, { 'rate-limited': 1 });
    assert.ok(Array.isArray(described.providersWithoutMalSyncCoverage), 'the static lists are untouched');
  });

  test('MangaXrefFaultLog is bounded, so a sustained outage cannot grow memory without bound', () => {
    const log = new MangaXrefFaultLog();
    for (let i = 0; i < 250; i++)
      log.record({
        stage: 'bridge',
        where: 'malsync',
        anilistId: String(i),
        fault: { kind: 'rate-limited', source: 'malsync', status: 429, detail: 'HTTP 429' },
        at: Date.now(),
      });
    assert.equal(log.total, 250, 'the counter is honest about everything that happened');
    assert.equal(log.recent().length, 100, 'but only a bounded window is retained');
    assert.equal(log.summary().retained, 100);
    assert.equal(log.forAnilistId('0').length, 0, 'the oldest were evicted');
    assert.equal(log.forAnilistId('249').length, 1);
  });
});

// =============================================================================================
// RETRY-AFTER — two legal forms, a cap, a floor, and a fallback that is not zero.
// =============================================================================================

describe('manga-xref: Retry-After is honoured, clamped, and never trusted blindly', () => {
  const HTTP_DATE = ms => new Date(realDateNow.call(Date) + clockOffset + ms).toUTCString();

  /** Run one refused MAL-Sync lookup and hand back the fault the LAYER exposed. */
  const faultFor = async headers => {
    const { layer, malsyncBridge } = layerFor({ [MALSYNC_13]: { status: 429, data: '', headers } });
    await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));
    assert.equal(layer.faults.total, 1);
    return layer.faults.recent()[0].fault;
  };

  test('form 1 — delta-seconds is taken literally', async () => {
    assert.equal((await faultFor({ 'retry-after': '120' })).retryAfterMs, 120_000);
  });

  test('form 2 — an HTTP-date is converted to a delta from now', async () => {
    const ms = (await faultFor({ 'retry-after': HTTP_DATE(90_000) })).retryAfterMs;
    // toUTCString() truncates to whole seconds, so allow the sub-second rounding loss.
    assert.ok(Math.abs(ms - 90_000) <= 1000, `expected ~90000ms, got ${ms}`);
  });

  test('the date branch must never see a bare number — Date.parse("120") is the year 120', async () => {
    // The ordering bug this guards is silent and total: probing the date form first turns
    // `Retry-After: 120` into a timestamp ~1900 years in the past, which then clamps to the FLOOR.
    // Getting 1000 back here instead of 120000 would mean the branches are the wrong way round.
    assert.equal(parseRetryAfterMs('120'), 120_000);
    assert.notEqual(parseRetryAfterMs('120'), RETRY_AFTER_MIN_MS);
    assert.equal(parseRetryAfterMs('2026'), RETRY_AFTER_MAX_MS, '2026 seconds, capped — not the year 2026');
  });

  test('the CAP holds — a hostile or absurd value cannot wedge the cache', async () => {
    assert.equal((await faultFor({ 'retry-after': '86400' })).retryAfterMs, RETRY_AFTER_MAX_MS);
    assert.equal(parseRetryAfterMs('999999999999'), RETRY_AFTER_MAX_MS);
    assert.equal(parseRetryAfterMs('9'.repeat(400)), RETRY_AFTER_MAX_MS, 'Infinity clamps rather than throwing');
    // And the cap must stay BELOW the genuine-miss TTL, or a refusal outlives a verified absence.
    assert.ok(RETRY_AFTER_MAX_MS < 10 * 60 * 1000);
  });

  test('the FLOOR holds — a past date, a zero, and a negative all mean "soon", never "now"', async () => {
    assert.equal((await faultFor({ 'retry-after': '0' })).retryAfterMs, RETRY_AFTER_MIN_MS);
    assert.equal((await faultFor({ 'retry-after': HTTP_DATE(-60_000) })).retryAfterMs, RETRY_AFTER_MIN_MS);
    assert.equal(
      parseRetryAfterMs('Fri, 31 Dec 1999 23:59:59 GMT'),
      RETRY_AFTER_MIN_MS,
      'a badly stale date is still a statement; it floors rather than being discarded'
    );
  });

  test('an unparseable or absent header falls back to the 30s guess — NOT to zero', async () => {
    // "upstream said nothing" and "upstream said zero" are different statements and the fault must
    // not conflate them, or this item would have reintroduced its own bug one layer down.
    assert.equal((await faultFor({})).retryAfterMs, undefined, 'no header at all');
    assert.equal((await faultFor({ 'retry-after': 'soon' })).retryAfterMs, undefined);
    assert.equal((await faultFor({ 'retry-after': '   ' })).retryAfterMs, undefined);
    // THE NUMERIC-ISH TRAP, and this assertion caught a real defect in the first implementation.
    // `12.5` is an illegal delta-seconds (not an integer) — but `Date.parse('12.5')` SUCCEEDS in
    // V8, yielding a date in the current year, which then clamped to the 1s FLOOR. A malformed
    // header was therefore SHORTENING the back-off below the 30s default, the exact opposite of
    // safe. Same family as `-5` and `1,5`.
    assert.equal((await faultFor({ 'retry-after': '12.5' })).retryAfterMs, undefined, 'not an integer, not a date');
    assert.equal(parseRetryAfterMs('12.5'), null);
    assert.equal(parseRetryAfterMs('-5'), null);
    assert.equal(parseRetryAfterMs('1,5'), null);
    assert.equal(parseRetryAfterMs(undefined), null);
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs({}), null);
  });

  test('the header name is matched case-insensitively, and a repeated header takes the first value', () => {
    assert.equal(retryAfterFromHeaders({ 'Retry-After': '45' }), 45_000);
    assert.equal(retryAfterFromHeaders({ 'RETRY-AFTER': '45' }), 45_000);
    assert.equal(retryAfterFromHeaders({ 'retry-after': ['45', '600'] }), 45_000);
    assert.equal(retryAfterFromHeaders({ 'x-other': '45' }), null);
    assert.equal(retryAfterFromHeaders(undefined), null);
    // AxiosHeaders exposes .get(); a plain object does not. Both must work.
    assert.equal(retryAfterFromHeaders({ get: name => (name === 'retry-after' ? '45' : undefined) }), 45_000);
  });

  // -------------------------------------------------------------------------------------------
  // AND THE POINT OF ALL OF IT: the parsed value actually drives the cache lifetime, observed by
  // counting upstream requests through the layer — not by reading a private cache.
  // -------------------------------------------------------------------------------------------

  test('a stated 120s window outlives the flat 30s guess, and expires when upstream said it would', async () => {
    const { layer, malsyncBridge, adapter } = layerFor({
      [MALSYNC_13]: [
        { status: 429, data: '', headers: { 'retry-after': '120' } },
        { status: 200, data: MALSYNC_ONE_PIECE },
      ],
    });

    await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));
    assert.equal(adapter.countFor(MALSYNC_13), 1);

    // Past the layer's own guess. Under the old flat TTL this would re-request and hammer an
    // upstream that explicitly asked for two minutes.
    advance(TTL_ERROR_MS + 1000);
    const { result: stillCached } = await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));
    assert.equal(stillCached, null);
    assert.equal(adapter.countFor(MALSYNC_13), 1, 'upstream asked for 120s and got 120s');

    // Past the window upstream named. The refusal must NOT be sticky beyond it.
    advance(120_000);
    const { result: recovered } = await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));
    assert.equal(adapter.countFor(MALSYNC_13), 2);
    assert.equal(recovered, 'one_piece', 'and the real mapping is served the moment the window passes');
    // TWO events for ONE upstream refusal, and that is correct rather than double-counting: the
    // second lookup was served the CACHED fault, and a caller inside the back-off window must be
    // told "we could not find out" just as clearly as the caller who triggered the refusal. If a
    // cached fault reported nothing, the whole window would read as "no mapping" again.
    assert.equal(layer.faults.total, 2, 'the refusal explains itself for every caller it degrades');
    assert.equal(layer.faults.summary().bySource.malsync, 2);
  });

  test('with NO Retry-After the 30s fallback is unchanged — the pre-existing behaviour is preserved', async () => {
    const { malsyncBridge, adapter } = layerFor({
      [MALSYNC_13]: [{ status: 429, data: '' }, { status: 200, data: MALSYNC_ONE_PIECE }],
    });

    await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));
    advance(TTL_ERROR_MS + 1000);
    const { result: recovered } = await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));

    assert.equal(adapter.countFor(MALSYNC_13), 2);
    assert.equal(recovered, 'one_piece');
  });

  test('an absurd 24h Retry-After is capped, so a hostile upstream cannot wedge the bridge for a day', async () => {
    const { malsyncBridge, adapter } = layerFor({
      [MALSYNC_13]: [
        { status: 429, data: '', headers: { 'retry-after': '86400' } },
        { status: 200, data: MALSYNC_ONE_PIECE },
      ],
    });

    await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));
    advance(RETRY_AFTER_MAX_MS + 1000);
    const { result: recovered } = await quiet(() => malsyncBridge.lookup(ONE_PIECE_META, 'MangaHere'));

    assert.equal(adapter.countFor(MALSYNC_13), 2, 'capped at 5 minutes, not obeyed for 24 hours');
    assert.equal(recovered, 'one_piece');
  });
});
