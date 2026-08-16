// GET /manga/chapters — the `releaseDate` / `releaseDatePrecision` / `releaseDateRaw` CONTRACT.
//
// WHAT THIS PROTECTS, AND WHY IT LOOKS DIFFERENT FROM manga-wired.test.mjs. manga-routes.mjs's
// header documents a three-field guarantee on every chapter it serves: `releaseDate` is normalised,
// `releaseDatePrecision` declares which of three shapes it is, and `releaseDateRaw` appears exactly
// when normalisation rewrote the string. Until this file the api suite had NO coverage of it — the
// suite stayed at 116/116 under a mutation of the aggregator's date handling, because every other
// wired test drives the routes with `makeFakeAggregator` and therefore reads back fields the
// FIXTURE wrote. A route-side or aggregator-side change could break the documented guarantee with
// nothing in this suite noticing.
//
// So this file mounts the real routes on the REAL `MangaAggregator` from consumet/dist (the same
// bundle server.mjs loads) with duck-typed fake PROVIDERS injected through its constructor. The
// raw strings below are the provider census; everything that turns them into the response — the
// `releasedDate` key search, `normalizeReleaseDate`, the raw-vs-value rule — is shipped code. That
// is the whole point: mutate the aggregator's date handling and these tests go red.
//
// Offline: see fixtures/manga-release-date-app.mjs. Every request that reached the aggregator's
// axios client is recorded and asserted empty at the end of each test.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startReleaseDateApp,
  dateProvider,
  ASURA_CHAPTERS,
  MANGAHERE_CHAPTERS,
  PASSTHROUGH_CHAPTERS,
  NO_DATE_CHAPTERS,
} from './fixtures/manga-release-date-app.mjs';

// Four providers, one per date shape. None is named 'MangaDex' — see the fixture header for why
// that name specifically would wake a bridge. 'AsuraDates'/'PassThruScans' are invented names for
// shapes that no single provider owns; 'MangaHere' and 'MangaPill' keep theirs because the shape
// under test IS that provider's (a misspelled key, and no date at all).
const PROVIDERS = [
  dateProvider('AsuraDates', ASURA_CHAPTERS),
  dateProvider('MangaHere', MANGAHERE_CHAPTERS),
  dateProvider('PassThruScans', PASSTHROUGH_CHAPTERS),
  dateProvider('MangaPill', NO_DATE_CHAPTERS),
];

let app;

before(async () => {
  app = await startReleaseDateApp(PROVIDERS);
});
after(async () => {
  await app?.close();
});

/** One /manga/chapters call, pinned to a provider so the walk cannot answer with a different one. */
const chaptersFrom = async provider => {
  const res = await fetch(`${app.base}/manga/chapters/30013?provider=${encodeURIComponent(provider)}`);
  assert.equal(res.status, 200, `${provider}: expected 200`);
  const body = await res.json();
  assert.equal(body.provider, provider, `${provider}: another provider answered — the pin did not hold`);
  assert.ok(Array.isArray(body.chapters) && body.chapters.length > 0, `${provider}: no chapters served`);
  // Asserted per test rather than once at the end, so a failure names the request that caused it.
  assert.deepEqual(app.netAttempts, [], 'the aggregator issued a real upstream request');
  return Object.fromEntries(body.chapters.map(c => [c.id, c]));
};

/** Indexes the served chapters by id for every provider at once. */
const allServedChapters = async () => {
  const out = [];
  for (const p of PROVIDERS) out.push(...Object.values(await chaptersFrom(p.parser.name)));
  return out;
};

describe('/manga/chapters releaseDate: the instant tier', () => {
  test('every ISO spelling is canonicalised to exactly YYYY-MM-DDTHH:MM:SS.sssZ and tagged instant', async () => {
    const ch = await chaptersFrom('AsuraDates');

    // [id, raw the provider emitted, the ONE canonical spelling it must become]
    const expected = [
      ['as-1', '2026-03-19T06:13:09Z', '2026-03-19T06:13:09.000Z'], // no fractional part
      ['as-2', '2026-05-27T17:51:06.065Z', '2026-05-27T17:51:06.065Z'], // already canonical
      ['as-3', '2026-08-05T16:45:52.287297Z', '2026-08-05T16:45:52.287Z'], // six digits, truncated
      ['as-4', '2026-08-12T17:00:56.65804Z', '2026-08-12T17:00:56.658Z'], // five digits
      ['as-5', '2026-04-10T14:43:10.75Z', '2026-04-10T14:43:10.750Z'], // two digits, zero-padded
      ['as-6', '2025-09-20T11:03:09.000000Z', '2025-09-20T11:03:09.000Z'], // MangaKakalot's shape
      ['as-7', '2025-09-20T11:03:09+09:00', '2025-09-20T02:03:09.000Z'], // offset really applied
    ];

    for (const [id, raw, canonical] of expected) {
      const c = ch[id];
      assert.ok(c, `${id} was not served`);
      assert.equal(c.releaseDate, canonical, `${id}: ${raw} was not canonicalised`);
      assert.equal(c.releaseDatePrecision, 'instant', `${id}: precision must declare the instant tier`);
      // The tier's own promise: safe to `new Date()`, and the string round-trips to itself.
      assert.equal(new Date(c.releaseDate).toISOString(), c.releaseDate, `${id}: not a parseable instant`);
      assert.match(
        c.releaseDate,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        `${id}: instant is not the exact documented shape`
      );

      // `releaseDateRaw` means "this differs from upstream" — present exactly when it does.
      if (raw === canonical) {
        assert.equal(
          'releaseDateRaw' in c,
          false,
          `${id}: nothing was rewritten, so releaseDateRaw must be absent (got ${c.releaseDateRaw})`
        );
      } else {
        assert.equal(c.releaseDateRaw, raw, `${id}: the provider's original string was not preserved`);
      }
    }
  });

  test('canonicalisation makes string sort equal time sort across the mixed spellings', async () => {
    // The hazard the normalisation exists to remove: '.' (0x2E) sorts before 'Z' (0x5A), so
    // '...T17:00:56.65804Z' string-sorts BEFORE '...T17:00:56Z' while being 658 ms later. Sorting
    // the RAW strings and the canonical ones must now give the same order.
    const ch = await chaptersFrom('AsuraDates');
    const served = Object.values(ch).filter(c => c.releaseDate);
    const byString = [...served].sort((a, b) => a.releaseDate.localeCompare(b.releaseDate)).map(c => c.id);
    const byTime = [...served].sort((a, b) => Date.parse(a.releaseDate) - Date.parse(b.releaseDate)).map(c => c.id);
    assert.deepEqual(byString, byTime, 'canonical instants do not string-sort into time order');
  });
});

describe('/manga/chapters releaseDate: the day tier', () => {
  test("MangaHere's 'Nov 05,2018' becomes 2018-11-05, day-precision, original preserved", async () => {
    const ch = await chaptersFrom('MangaHere');
    const c = ch['mh-1'];

    assert.equal(c.releaseDate, '2018-11-05');
    assert.equal(c.releaseDatePrecision, 'day');
    assert.equal(c.releaseDateRaw, 'Nov 05,2018', 'the provider original must survive as releaseDateRaw');
    // THE POINT OF THE TIER. The provider stated no time and no zone; fabricating one is wrong by
    // up to a day either side for anyone not on UTC.
    assert.equal(c.releaseDate.includes('T'), false, 'a time component was fabricated');
    assert.equal(/00:00:00/.test(c.releaseDate), false, 'midnight was fabricated');
    assert.equal(c.releaseDate.endsWith('Z'), false, 'a UTC zone was fabricated');
    assert.match(c.releaseDate, /^\d{4}-\d{2}-\d{2}$/, 'day tier is not the exact documented shape');
  });

  test('the whole named-month family normalises, and an impossible date does NOT roll forward', async () => {
    const ch = await chaptersFrom('MangaHere');

    assert.equal(ch['mh-2'].releaseDate, '2025-01-09');
    assert.equal(ch['mh-2'].releaseDatePrecision, 'day');
    assert.equal(ch['mh-3'].releaseDate, '2019-09-03', 'a full month name is just as unambiguous');
    assert.equal(ch['mh-3'].releaseDatePrecision, 'day');

    // Already a canonical ISO calendar date: still 'day', but nothing was rewritten, so no `raw`.
    assert.equal(ch['mh-4'].releaseDate, '2018-11-05');
    assert.equal(ch['mh-4'].releaseDatePrecision, 'day');
    assert.equal('releaseDateRaw' in ch['mh-4'], false, 'an unchanged value must not carry releaseDateRaw');

    // 'Feb 30,2025' is not a date. `Date.UTC` would roll it to Mar 2; the contract says reject and
    // pass through, because a silently-shifted date is worse than an unparsed one.
    assert.equal(ch['mh-5'].releaseDate, 'Feb 30,2025', 'an impossible date was invented into a real one');
    assert.equal(ch['mh-5'].releaseDatePrecision, 'unknown');
    assert.equal('releaseDateRaw' in ch['mh-5'], false);
  });
});

describe('/manga/chapters releaseDate: the unknown tier passes through byte-identically', () => {
  test('ambiguous, relative, partial and unzoned values are never silently converted', async () => {
    const ch = await chaptersFrom('PassThruScans');

    for (const [id, raw] of [
      ['pt-1', '03/04/2018'], // DD/MM vs MM/DD — picking one invents a date
      ['pt-2', '2 days ago'], // relative
      ['pt-3', 'Nov 2018'], // partial: widening to the 1st manufactures a day
      ['pt-4', '2018'], // partial
      ['pt-5', '2025-09-20T11:03:09'], // no zone: up to 26 hours of invented error
    ]) {
      const c = ch[id];
      assert.ok(c, `${id} was not served`);
      assert.equal(c.releaseDate, raw, `${id}: '${raw}' was not passed through byte-identically`);
      assert.equal(c.releaseDatePrecision, 'unknown', `${id}: a pass-through must declare the unknown tier`);
      assert.equal('releaseDateRaw' in c, false, `${id}: nothing was rewritten, so no releaseDateRaw`);
    }

    // A pass-through must not be MISTAKEABLE for a normalised value: it may not accidentally
    // satisfy either canonical shape while claiming the unknown tier.
    for (const c of Object.values(ch)) {
      if (c.releaseDatePrecision !== 'unknown') continue;
      assert.equal(
        /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(c.releaseDate),
        false,
        `${c.id}: an 'unknown' value is spelled like a normalised one — the tiers are indistinguishable`
      );
    }
  });

  test('the documented whitespace caveat: trimming alone never sets releaseDateRaw', async () => {
    const ch = await chaptersFrom('PassThruScans');
    const c = ch['pt-6'];
    assert.equal(c.releaseDate, '03/04/2018', 'surrounding whitespace is stripped before anything else');
    assert.equal(c.releaseDatePrecision, 'unknown');
    assert.equal('releaseDateRaw' in c, false, "a whitespace-only strip must not count as 'rewritten'");
  });
});

describe('/manga/chapters releaseDate: the field triple is coherent on EVERY chapter', () => {
  test('precision accompanies every releaseDate across every provider, not merely most', async () => {
    const served = await allServedChapters();
    // Guards the assertion itself: if the fixtures ever stop reaching the route, the loop below
    // would pass vacuously.
    assert.equal(
      served.length,
      ASURA_CHAPTERS.length + MANGAHERE_CHAPTERS.length + PASSTHROUGH_CHAPTERS.length + NO_DATE_CHAPTERS.length,
      'not every fixture chapter reached the route'
    );

    const dated = served.filter(c => c.releaseDate !== undefined);
    assert.ok(dated.length >= 17, `expected the dated fixtures to survive, got ${dated.length}`);

    for (const c of served) {
      const hasDate = 'releaseDate' in c;
      const hasPrecision = 'releaseDatePrecision' in c;
      // Present EXACTLY together — in both directions. A precision with no date is as broken as a
      // date with no precision.
      assert.equal(
        hasPrecision,
        hasDate,
        `${c.id}: releaseDate/releaseDatePrecision are not present together ` +
          `(${JSON.stringify({ releaseDate: c.releaseDate, releaseDatePrecision: c.releaseDatePrecision })})`
      );
      if (!hasDate) {
        // MangaPill's permanent state, and the same for an empty/whitespace value: all THREE keys
        // are legitimately absent. `releaseDateRaw` alone would be provenance for nothing.
        assert.equal('releaseDateRaw' in c, false, `${c.id}: releaseDateRaw with no releaseDate`);
        continue;
      }
      assert.ok(
        ['instant', 'day', 'unknown'].includes(c.releaseDatePrecision),
        `${c.id}: '${c.releaseDatePrecision}' is not one of the three declared tiers`
      );
      assert.equal(typeof c.releaseDate, 'string', `${c.id}: releaseDate must be a string`);
      // The tier is not decorative: each one pins the SHAPE of the value it labels.
      if (c.releaseDatePrecision === 'instant')
        assert.match(c.releaseDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${c.id}: bad instant`);
      if (c.releaseDatePrecision === 'day')
        assert.match(c.releaseDate, /^\d{4}-\d{2}-\d{2}$/, `${c.id}: bad day`);
      if ('releaseDateRaw' in c)
        assert.notEqual(c.releaseDateRaw, c.releaseDate, `${c.id}: releaseDateRaw duplicates releaseDate`);
    }
  });

  test('a provider that states no date yields all three keys absent, not nulls or empty strings', async () => {
    const ch = await chaptersFrom('MangaPill');
    for (const id of ['mp-1', 'mp-2', 'mp-3', 'mp-4']) {
      const c = ch[id];
      assert.ok(c, `${id} was not served`);
      assert.equal('releaseDate' in c, false, `${id}: a date appeared where the provider stated none`);
      assert.equal('releaseDatePrecision' in c, false, `${id}: precision without a date`);
      assert.equal('releaseDateRaw' in c, false, `${id}: raw without a date`);
      // The rest of the chapter is intact — absence of a date is not a degraded row.
      assert.equal(c.chapterNumber, id.slice(-1));
    }
  });

  test('the route serialises the triple over the wire as JSON strings, not Dates', async () => {
    // Belt and braces on the HTTP layer specifically: a Date object surviving into the envelope
    // would serialise to an ISO string and LOOK right in every assertion above, but would be a
    // different type to any consumer reading the aggregator directly. Read the raw body text.
    const res = await fetch(`${app.base}/manga/chapters/30013?provider=MangaHere`);
    const text = await res.text();
    assert.ok(
      text.includes('"releaseDate":"2018-11-05","releaseDatePrecision":"day","releaseDateRaw":"Nov 05,2018"'),
      `the three fields are not adjacent JSON strings in the response body: ${text.slice(0, 400)}`
    );
  });
});
