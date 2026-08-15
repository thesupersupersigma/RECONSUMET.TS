// `releaseDate` returned TWO FORMATS FROM ONE ENDPOINT — and, it turns out, five.
//
// THE BUG. `/manga/chapters` is answered by whichever of the seven registered providers won the
// selection, and the providers do not agree on how to write a date. Since the servability policy
// made MangaHere the default for Solo Leveling and One Piece, one caller hitting one endpoint got
// `"2023-09-05T17:14:12.000Z"` for one title and `"Jan 09,2025"` for another, in the same field,
// with nothing in the response saying which it was holding. The previous pass documented that and
// declined to normalise, on the grounds that "guessing a locale is how you invent a wrong date".
// That reasoning is right and is preserved (see the 'never guess' block below); it just does not
// reach an English month abbreviation.
//
// WHAT THE LIVE SURVEY FOUND, and why "already ISO" was not good enough. Measured 2026-08-14 over
// 5,993 chapter rows, every one of the seven registered providers:
//
//   MangaDex       30/30 rows      "2023-09-05T17:14:12.000Z"
//   FlameComics    200/200         "2025-02-17T16:43:07.000Z"
//   WeebCentral    201/201         "2024-09-07T17:04:15.717Z"
//   MangaKakalot   2188/2188       "2025-09-20T11:03:09.000000Z"   six-digit fraction
//   MangaHere      3306/3306       "Jan 09,2025"                   named month, no time, no zone
//   MangaPill      0/1487          field absent entirely — a finding, not an oversight
//   AsuraScans     1039/1039       FIVE SHAPES IN ONE FIELD (six series, re-measured 2026-08-14 by
//                                  the verification pass — the first sweep saw only four):
//                    957 x "2026-03-19T06:13:09Z"          no fraction
//                     42 x "2026-05-27T17:51:06.065Z"      three digits
//                     36 x "2026-08-05T16:45:52.287297Z"   six digits
//                      3 x "2026-08-12T17:00:56.65804Z"    five — trailing zero trimmed
//                      1 x "2026-04-10T14:43:10.75Z"       TWO — both trailing zeros trimmed
//
// The fifth shape is the standing warning about this census: it is a SAMPLE, and a wider sample found
// a rendering the narrower one missed. The parser accepts any fractional-digit count precisely so
// that finding a sixth costs nothing, but the counts above are from that sweep, not the catalogue.
//
// AsuraScans is the case that decides the design. Its serialiser trims trailing zeros, so the
// rendering varies ROW TO ROW inside a single chapter list, and those renderings do not sort
// together: '.' is 0x2E, 'Z' is 0x5A, so `"...T17:00:56.65804Z"` sorts BEFORE `"...T17:00:56Z"`
// while being 658 ms later. Sorting an array of ISO strings is the obvious thing to do with ISO
// strings, and on a mixed list it is not safe. So "it already looks like ISO, leave it" is not a
// defensible position. Test 'the sort inversion' below is that pair.
//
// BE PRECISE ABOUT WHAT IS OBSERVED, THOUGH. Both SPELLINGS in that pair are real AsuraScans output.
// An inverting pair only arises when two chapters share a wall-clock SECOND while being spelled
// differently, and the verification sweep did not find one live: across 1,039 dated rows / 940
// distinct seconds, zero same-second multi-spelling collisions, and raw string-sort still happened
// to equal time-sort. So the ordering hazard is LATENT rather than currently manifest — a property
// of the format the provider emits, not a wrong order anyone has been served today. The other
// consequences of mixed spellings are unconditional and need no collision: string equality, dedup
// and cross-provider comparison all fail on values that denote the same instant. Canonicalisation
// is justified on those plus the latent inversion; it is not justified by a mis-ordering that has
// been measured in the wild, because it has not been.
//
// WHAT IS PINNED HERE.
//
//   1. A TEST PER PROVIDER ASSERTING THE ACTUAL EMITTED FORMAT. `CENSUS` below carries each
//      provider's verbatim live string under the exact key that provider emits (MangaHere and
//      MangaKakalot misspell it `releasedDate`), and each case asserts BOTH that the raw string
//      still matches that provider's documented shape AND the exact normalised triple the
//      aggregator produces from it. If a provider starts emitting a sixth format, whoever updates
//      the fixture has to change a named shape assertion — it cannot ship silently, which is the
//      durable half of this item.
//
//   2. A PASS-THROUGH IS DISTINGUISHABLE FROM A NORMALISED VALUE. This repo's recurring failure is
//      "two different things rendered identically", and a normaliser that only rewrites the string
//      leaves a client sniffing to find out whether `new Date()` is safe. So `releaseDatePrecision`
//      rides alongside every date — 'instant' | 'day' | 'unknown' — and `releaseDateRaw` appears
//      exactly when the string was rewritten. The invariants are asserted over the whole census.
//
//   3. NEVER GUESS. Locale-ambiguous ('03/04/2018'), relative ('2 days ago'), partial ('Nov 2018')
//      and zone-less ('2025-09-20T11:03:09') input is passed through VERBATIM and flagged 'unknown'.
//      Nothing is widened to a January 1st, nothing is resolved against `Date.now()`, no timezone is
//      assumed. These are the tests that fail if someone later "improves" the parser by handing the
//      string to `new Date()`.
//
//   4. NO INVENTED PRECISION ON MANGAHERE. `"Jan 09,2025"` becomes the calendar date `"2025-01-09"`,
//      NOT `"2025-01-09T00:00:00Z"` — the provider stated no time and no zone, and a fabricated UTC
//      midnight is wrong by up to a day for anyone not on UTC.
//
//   5. THE ENGINE IS NOT TRUSTED. `Date.parse` is implementation-defined off the ISO path, so
//      'Feb 30,2025' and '2025-02-29' must be REJECTED (passed through as 'unknown') rather than
//      rolled forward into a real date that nobody wrote.
//
// Offline: no network, no fixtures larger than a date string. The provider strings are captured
// live values, the providers themselves are duck-typed fakes injected through the constructor.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const aggMod = require('../dist/providers/meta/manga-aggregator.js');
const MangaAggregator = aggMod.default ?? aggMod;
const { normalizeReleaseDate } = require('../dist/providers/meta/manga-release-date.js');

/** Swallow the aggregator's diagnostic logs; this suite asserts on values, not on logging. */
const quiet = async fn => {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
};

const meta = () => ({ resolve: async () => ({ anilistId: '105398', titles: ['Solo Leveling'] }) });

/** A duck-typed MangaParser serving exactly the chapter rows given. Same shape as the sibling suites. */
const fake = (name, chapters) => ({
  parser: {
    name,
    async search() {
      return { results: [{ id: 'sl-1', title: 'Solo Leveling' }] };
    },
    async fetchMangaInfo(id) {
      return { id, title: 'Solo Leveling', chapters };
    },
    async fetchChapterPages() {
      return [{ page: 1, img: 'https://example.invalid/1.jpg' }];
    },
  },
});

/** Run one provider's rows through the REAL aggregator and hand back the normalised chapters. */
const throughAggregator = async (providerName, rows) => {
  const agg = new MangaAggregator({ providers: [fake(providerName, rows)], metadata: meta(), bridges: [] });
  const out = await quiet(() => agg.getChapters(105398));
  return out.chapters;
};

// =================================================================================================
// THE CENSUS — one entry per registered provider, verbatim from the live survey.
//
// `key` is the field name that provider actually emits (MangaHere and MangaKakalot misspell it).
// `shape` is the documented format, asserted against the raw string so a fixture cannot quietly
// mutate into a new format. `expect` is the exact triple the aggregator must produce.
// =================================================================================================
const CENSUS = [
  {
    provider: 'MangaDex',
    key: 'releaseDate',
    raw: '2023-09-05T17:14:12.000Z',
    shape: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    note: 'from readableAt, already run through toISOString() by the provider',
    expect: { releaseDate: '2023-09-05T17:14:12.000Z', releaseDatePrecision: 'instant', releaseDateRaw: undefined },
  },
  {
    provider: 'FlameComics',
    key: 'releaseDate',
    raw: '2025-02-17T16:43:07.000Z',
    shape: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    note: 'built from unix seconds by asIsoDate(), so canonical by construction',
    expect: { releaseDate: '2025-02-17T16:43:07.000Z', releaseDatePrecision: 'instant', releaseDateRaw: undefined },
  },
  {
    provider: 'WeebCentral',
    key: 'releaseDate',
    raw: '2024-09-07T17:04:15.717Z',
    shape: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    note: "the <time datetime> attribute, which is clean; the element TEXT is microsecond-precision",
    expect: { releaseDate: '2024-09-07T17:04:15.717Z', releaseDatePrecision: 'instant', releaseDateRaw: undefined },
  },
  {
    provider: 'AsuraScans/no-fraction',
    key: 'releaseDate',
    raw: '2024-07-13T02:15:04Z',
    shape: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    note: '573 of 594 rows. NOT canonical: rewritten to .000Z so it sorts with the others',
    expect: { releaseDate: '2024-07-13T02:15:04.000Z', releaseDatePrecision: 'instant', releaseDateRaw: '2024-07-13T02:15:04Z' },
  },
  {
    provider: 'AsuraScans/3-digit',
    key: 'releaseDate',
    raw: '2026-05-27T17:51:06.065Z',
    shape: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    note: '10 of 594 rows — already canonical, so no rewrite and no raw',
    expect: { releaseDate: '2026-05-27T17:51:06.065Z', releaseDatePrecision: 'instant', releaseDateRaw: undefined },
  },
  {
    provider: 'AsuraScans/6-digit',
    key: 'releaseDate',
    raw: '2026-08-05T16:45:52.287297Z',
    shape: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    note: '9 of 594 rows. Microseconds truncated (not rounded) — a Date is millisecond-resolution',
    expect: { releaseDate: '2026-08-05T16:45:52.287Z', releaseDatePrecision: 'instant', releaseDateRaw: '2026-08-05T16:45:52.287297Z' },
  },
  {
    provider: 'AsuraScans/5-digit',
    key: 'releaseDate',
    raw: '2026-08-12T17:00:56.65804Z',
    shape: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{5}Z$/,
    note: '2 of 594 rows — trailing zero trimmed. A fixed \\d{3} or \\d{6} parser would miss this',
    expect: { releaseDate: '2026-08-12T17:00:56.658Z', releaseDatePrecision: 'instant', releaseDateRaw: '2026-08-12T17:00:56.65804Z' },
  },
  {
    // Found by the verification pass, NOT by the pass that wrote this file — which is the point of
    // keeping the parser digit-count-agnostic. A wider live sweep (1,039 dated rows over six series,
    // 2026-08-14) turned up a FIFTH rendering the original three-series sample never hit. Nothing had
    // to change to support it; it is pinned here so the census stops claiming there are only four.
    provider: 'AsuraScans/2-digit',
    key: 'releaseDate',
    raw: '2026-04-10T14:43:10.75Z',
    shape: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{2}Z$/,
    note: '1 of 1039 rows — .750 with BOTH trailing zeros trimmed; the rarest shape observed so far',
    expect: { releaseDate: '2026-04-10T14:43:10.750Z', releaseDatePrecision: 'instant', releaseDateRaw: '2026-04-10T14:43:10.75Z' },
  },
  {
    provider: 'MangaKakalot',
    key: 'releasedDate', // misspelled at the source; the aggregator maps it across
    raw: '2025-09-20T11:03:09.000000Z',
    shape: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    note: 'ISO-SHAPED BUT NOT CANONICAL. new Date() copes; string equality and sorting do not',
    expect: { releaseDate: '2025-09-20T11:03:09.000Z', releaseDatePrecision: 'instant', releaseDateRaw: '2025-09-20T11:03:09.000000Z' },
  },
  {
    provider: 'MangaHere',
    key: 'releasedDate', // misspelled at the source; the aggregator maps it across
    raw: 'Jan 09,2025',
    shape: /^[A-Z][a-z]{2} \d{2},\d{4}$/,
    note: 'the only non-ISO shape normalised. Unambiguous: the month is NAMED, in English',
    expect: { releaseDate: '2025-01-09', releaseDatePrecision: 'day', releaseDateRaw: 'Jan 09,2025' },
  },
];

describe('per-provider: the format each of the seven actually emits, and what it becomes', () => {
  for (const c of CENSUS) {
    test(`${c.provider} — ${c.note}`, async () => {
      assert.match(
        c.raw,
        c.shape,
        `${c.provider}'s captured string no longer matches its documented shape. If the provider ` +
          `genuinely changed format, that is a new format on a shared field — update the census AND ` +
          `check normalizeReleaseDate still handles it.`
      );

      const [chapter] = await throughAggregator(c.provider, [
        { id: 'ch-1', title: 'Chapter 1', chapterNumber: '1', [c.key]: c.raw },
      ]);

      assert.equal(chapter.releaseDate, c.expect.releaseDate);
      assert.equal(chapter.releaseDatePrecision, c.expect.releaseDatePrecision);
      assert.equal(chapter.releaseDateRaw, c.expect.releaseDateRaw);
    });
  }

  test('MangaPill — emits NO date at all (0 of 1487 rows sampled), so no date fields appear', async () => {
    // Not an oversight in the scrape: MangaPill's chapter markup carries only id/title/chapter.
    // The contract must be "the fields are absent", not "the fields are empty strings".
    const [chapter] = await throughAggregator('MangaPill', [
      { id: '2-11190000/one-piece-chapter-1190', title: 'Chapter 1190', chapter: '1190' },
    ]);
    assert.equal(chapter.releaseDate, undefined);
    assert.equal(chapter.releaseDatePrecision, undefined);
    assert.equal(chapter.releaseDateRaw, undefined);
    assert.ok(!('releaseDate' in chapter), 'the key must be ABSENT, not present-and-undefined');
    assert.ok(!('releaseDatePrecision' in chapter), 'a precision with no date to describe is meaningless');
  });

  test('every provider that emits a date yields ONE canonical spelling per precision class', async () => {
    // The point of the whole item, stated as one assertion: after normalisation there are exactly
    // two output grammars, not five. Before the fix this set had five members.
    const instants = new Set();
    const days = new Set();
    for (const c of CENSUS) {
      const [ch] = await throughAggregator(c.provider, [{ id: 'x', title: 'x', [c.key]: c.raw }]);
      if (ch.releaseDatePrecision === 'instant') instants.add(ch.releaseDate.replace(/\d/g, 'N'));
      if (ch.releaseDatePrecision === 'day') days.add(ch.releaseDate.replace(/\d/g, 'N'));
    }
    assert.deepEqual([...instants], ['NNNN-NN-NNTNN:NN:NN.NNNZ'], `instants must all be spelled one way: ${[...instants]}`);
    assert.deepEqual([...days], ['NNNN-NN-NN'], `dates must all be spelled one way: ${[...days]}`);
  });
});

describe('the defect canonicalisation actually fixes: mixed precision breaks lexicographic sort', () => {
  test('the sort inversion — two REAL AsuraScans rows, 658ms apart, sorted backwards as strings', () => {
    const earlier = '2026-08-12T17:00:56Z'; // observed shape, 573/594 rows
    const later = '2026-08-12T17:00:56.65804Z'; // observed shape, 2/594 rows — 658ms LATER

    // The bug, demonstrated on the raw values a client used to receive:
    assert.ok(Date.parse(earlier) < Date.parse(later), 'sanity: `earlier` really is earlier');
    assert.ok(!(earlier < later), 'RAW: the earlier instant sorts AFTER the later one as a string');

    // And gone after normalisation:
    const a = normalizeReleaseDate(earlier).value;
    const b = normalizeReleaseDate(later).value;
    assert.ok(a < b, `normalised strings must sort chronologically: ${a} vs ${b}`);
    assert.equal(a, '2026-08-12T17:00:56.000Z');
    assert.equal(b, '2026-08-12T17:00:56.658Z');
  });

  test('a whole mixed list sorts identically by string and by instant once normalised', () => {
    const raws = CENSUS.filter(c => c.expect.releaseDatePrecision === 'instant').map(c => c.raw);
    const byString = [...raws].map(r => normalizeReleaseDate(r).value).sort();
    const byInstant = [...raws].sort((x, y) => Date.parse(x) - Date.parse(y)).map(r => normalizeReleaseDate(r).value);
    assert.deepEqual(byString, byInstant);
  });
});

describe('never guess: ambiguous, relative, partial and zone-less input is passed through untouched', () => {
  // Each of these is a string somebody could reasonably be tempted to "handle". Each one, handled,
  // invents a fact. The assertion is that the value comes back BYTE-FOR-BYTE and is flagged.
  const PASS_THROUGH = [
    ['03/04/2018', 'DD/MM and MM/DD are both live readings; picking one invents a date'],
    ['4/3/2018', 'same ambiguity, unpadded'],
    ['2 days ago', 'relative — resolving it against Date.now() makes the response non-deterministic'],
    ['Today', 'relative AND zone-dependent: whose today?'],
    ['Yesterday', 'same'],
    ['2018', 'partial: widening to 2018-01-01 fabricates a month and a day'],
    ['Nov 2018', 'partial: fabricates a day'],
    ['2018-11', 'partial, even though it is ISO-shaped'],
    ['2025-09-20T11:03:09', 'ISO but ZONE-LESS — off by up to 26 hours depending on the zone invented'],
    ['2025-09-20 11:03:09', 'same, with a space separator'],
    ['Nov 05,2018 12:00', 'named month WITH a time but no zone — the zone rule outranks the month rule'],
    ['segunda-feira, 5 de novembro', 'a month named in a language this parser does not claim to read'],
    ['not a date at all', 'junk must survive as junk, not become undefined'],
  ];

  for (const [input, why] of PASS_THROUGH) {
    test(`${JSON.stringify(input)} — ${why}`, () => {
      const got = normalizeReleaseDate(input);
      assert.equal(got.value, input, 'the provider string must come back verbatim');
      assert.equal(got.precision, 'unknown', 'and must be labelled as unparsed');
      assert.equal(got.raw, undefined, 'nothing was rewritten, so there is no separate raw to report');
    });
  }

  test('a pass-through survives the aggregator too, not just the parser', async () => {
    const [chapter] = await throughAggregator('Hypothetical', [
      { id: 'ch-1', title: 'Chapter 1', releaseDate: '03/04/2018' },
    ]);
    assert.equal(chapter.releaseDate, '03/04/2018');
    assert.equal(chapter.releaseDatePrecision, 'unknown');
    assert.equal(chapter.releaseDateRaw, undefined);
  });
});

describe('never invent precision or a timezone', () => {
  test("MangaHere's date-only value stays date-only — no fabricated T00:00:00Z", () => {
    const got = normalizeReleaseDate('Nov 05,2018');
    assert.equal(got.value, '2018-11-05');
    assert.equal(got.precision, 'day');
    assert.ok(!got.value.includes('T'), 'a time the provider never stated must not appear');
    assert.ok(!/[Zz]|[+-]\d{2}:?\d{2}$/.test(got.value), 'a zone the provider never stated must not appear');
  });

  test('an ISO calendar date is recognised as a date, not silently promoted to an instant', () => {
    const got = normalizeReleaseDate('2018-11-05');
    assert.equal(got.value, '2018-11-05');
    assert.equal(got.precision, 'day');
    assert.equal(got.raw, undefined, 'already canonical — nothing was rewritten');
  });

  test('microsecond truncation goes DOWN, never up — a release must not move into the future', () => {
    // .999999 rounding to 1.000 would put the chapter in the next second.
    assert.equal(normalizeReleaseDate('2026-08-05T16:45:52.999999Z').value, '2026-08-05T16:45:52.999Z');
    assert.equal(normalizeReleaseDate('2026-08-05T16:45:52.9Z').value, '2026-08-05T16:45:52.900Z');
    assert.equal(normalizeReleaseDate('2026-08-05T16:45:52.65804Z').value, '2026-08-05T16:45:52.658Z');
  });

  test('an explicit non-UTC offset IS resolved — it is stated, not guessed', () => {
    // The rule is "never invent a zone", not "never accept one". MangaDex's API answers +00:00 on
    // the raw record, and a scraper could surface a real offset.
    assert.equal(normalizeReleaseDate('2018-01-31T07:07:06+00:00').value, '2018-01-31T07:07:06.000Z');
    assert.equal(normalizeReleaseDate('2018-01-31T16:07:06+09:00').value, '2018-01-31T07:07:06.000Z');
    assert.equal(normalizeReleaseDate('2018-01-30T23:07:06-08:00').value, '2018-01-31T07:07:06.000Z');
    assert.equal(normalizeReleaseDate('2018-01-31T16:07:06+0900').value, '2018-01-31T07:07:06.000Z');
  });
});

describe('the engine is not trusted: impossible dates are rejected, not rolled forward', () => {
  // `new Date('Feb 30, 2025')` is implementation-defined; V8 happily answers March 2nd. Anything
  // that leans on that turns a provider typo into a confident wrong date.
  const IMPOSSIBLE = ['Feb 30,2025', 'Feb 29,2025', '2025-02-29', '2025-13-01', '2025-00-10', '2025-01-32', 'Xyz 05,2018'];
  for (const input of IMPOSSIBLE) {
    test(`${JSON.stringify(input)} is not a real date, so it is passed through as 'unknown'`, () => {
      const got = normalizeReleaseDate(input);
      assert.equal(got.precision, 'unknown', `${input} must NOT be silently rolled into a valid date`);
      assert.equal(got.value, input);
    });
  }

  test('but a real leap day is accepted', () => {
    assert.deepEqual(normalizeReleaseDate('2024-02-29'), { value: '2024-02-29', precision: 'day' });
    assert.deepEqual(normalizeReleaseDate('Feb 29,2024'), { value: '2024-02-29', precision: 'day', raw: 'Feb 29,2024' });
  });

  test('out-of-range clock fields are rejected rather than rolled into the next day', () => {
    for (const input of ['2025-01-09T24:00:00Z', '2025-01-09T12:60:00Z', '2025-01-09T12:00:60Z'])
      assert.equal(normalizeReleaseDate(input).precision, 'unknown', `${input} must not roll over`);
  });
});

describe('the normaliser is total: it never throws and never invents a value', () => {
  for (const input of [undefined, null, 0, NaN, {}, [], new Date(), '', '   ', false])
    test(`${String(input === '' ? "''" : input)} yields undefined, meaning "there was no date here"`, () => {
      assert.equal(normalizeReleaseDate(input), undefined);
    });

  test('surrounding whitespace is trimmed but the value is otherwise untouched', () => {
    assert.equal(normalizeReleaseDate('  Jan 09,2025  ').value, '2025-01-09');
    assert.equal(normalizeReleaseDate('  ¯\\_(ツ)_/¯  ').value, '¯\\_(ツ)_/¯');
  });
});

describe('the distinguishability contract, asserted over the whole census', () => {
  test('releaseDatePrecision is present exactly when releaseDate is', async () => {
    const rows = [
      ...CENSUS.map((c, i) => ({ id: `c${i}`, title: 'x', [c.key]: c.raw })),
      { id: 'nodate', title: 'x' }, // the MangaPill case
      { id: 'junk', title: 'x', releaseDate: 'sometime last week' },
    ];
    const chapters = await throughAggregator('Mixed', rows);
    assert.equal(chapters.length, rows.length);
    for (const ch of chapters)
      assert.equal(
        ch.releaseDate === undefined,
        ch.releaseDatePrecision === undefined,
        `date and precision must appear together, got ${JSON.stringify(ch)}`
      );
  });

  test("releaseDateRaw appears ONLY when the string was rewritten, and then it really differs", async () => {
    const chapters = await throughAggregator(
      'Mixed',
      CENSUS.map((c, i) => ({ id: `c${i}`, title: 'x', [c.key]: c.raw }))
    );
    let rewritten = 0;
    for (const ch of chapters) {
      if (ch.releaseDateRaw === undefined) continue;
      rewritten++;
      assert.notEqual(ch.releaseDateRaw, ch.releaseDate, 'a raw identical to the value carries no information');
    }
    // Derived from CENSUS, not hardcoded. A literal here silently became wrong the moment a tenth
    // census row was added (the AsuraScans 2-digit shape), and a count that has to be hand-bumped
    // teaches whoever bumps it to bump rather than to check. Every entry whose fixture declares a
    // rewrite must produce a raw, and NO other entry may — which is the actual invariant, and it
    // pins each row individually instead of pinning a total that several wrong sets could satisfy.
    const expectRaw = CENSUS.filter(c => c.expect.releaseDateRaw !== undefined);
    for (const [i, c] of CENSUS.entries())
      assert.equal(
        chapters[i].releaseDateRaw,
        c.expect.releaseDateRaw,
        `${c.provider}: releaseDateRaw must be ${c.expect.releaseDateRaw ?? 'absent'}`
      );
    assert.equal(rewritten, expectRaw.length, 'exactly the non-canonical providers should report a raw');
    assert.ok(rewritten > 0 && rewritten < CENSUS.length, 'sanity: the census must contain both rewritten and untouched rows');
  });

  test("'unknown' never carries a raw — the value IS the provider's string", async () => {
    const [ch] = await throughAggregator('Mixed', [{ id: 'x', title: 'x', releaseDate: '2 days ago' }]);
    assert.equal(ch.releaseDatePrecision, 'unknown');
    assert.equal(ch.releaseDate, '2 days ago');
    assert.equal(ch.releaseDateRaw, undefined);
  });

  test("every 'instant' and 'day' value really is parseable — that is what the tag promises", () => {
    for (const c of CENSUS) {
      const got = normalizeReleaseDate(c.raw);
      assert.notEqual(got.precision, 'unknown', `${c.provider} must normalise`);
      assert.ok(Number.isFinite(Date.parse(got.value)), `${got.value} must be parseable`);
      // and the instant is preserved exactly, to the millisecond, by the rewrite
      if (got.precision === 'instant')
        assert.equal(Date.parse(got.value), Math.trunc(Date.parse(c.raw)), `${c.provider}: the rewrite moved the instant`);
    }
  });
});

describe('the field-name mapping the aggregator does, which normalisation must not break', () => {
  test('the misspelled `releasedDate` is still mapped across to `releaseDate`', async () => {
    const [ch] = await throughAggregator('MangaHere', [{ id: 'x', title: 'x', releasedDate: 'Nov 05,2018' }]);
    assert.equal(ch.releaseDate, '2018-11-05');
    assert.ok(!('releasedDate' in ch), 'the provider misspelling must not leak into the contract');
  });

  test('`releaseDate` wins over `releasedDate` when a provider somehow emits both', async () => {
    const [ch] = await throughAggregator('Both', [
      { id: 'x', title: 'x', releaseDate: '2023-09-05T17:14:12.000Z', releasedDate: 'Nov 05,2018' },
    ]);
    assert.equal(ch.releaseDate, '2023-09-05T17:14:12.000Z');
  });

  test('publishAt stays LAST and is never preferred — MangaDex parks a 2037 sentinel there', async () => {
    // Promoting publishAt would date exactly the unreadable rows wrongly. Normalisation must not
    // have quietly reordered the key search while touching this line.
    const [ch] = await throughAggregator('FakeDex', [
      { id: 'x', title: 'x', releaseDate: '2022-02-24T10:00:00.000Z', publishAt: '2037-12-31T15:00:00+00:00' },
    ]);
    assert.equal(ch.releaseDate, '2022-02-24T10:00:00.000Z');
    assert.ok(!ch.releaseDate.startsWith('2037'), 'the scheduling sentinel must never surface as a release date');
  });
});
