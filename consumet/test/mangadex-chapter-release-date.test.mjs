// MangaDex — every chapter carries a real `releaseDate`, taken from `readableAt` and not `publishAt`.
//
// WHAT THIS PROTECTS.
//
//  1. THE FIELD WAS SIMPLY MISSING. `fetchMangaInfo` built each chapter from
//     `{id, title, chapterNumber, volumeNumber, pages, externalUrl, readable}` and never touched
//     either date attribute, so 0 of Berserk's 425 English chapters carried a date. MangaAggregator's
//     `normalizeChapter` looks for `releaseDate | releasedDate | updatedAt | publishAt` and found
//     none of them, so `/manga/chapters` shipped a dateless chapter list for the one provider that
//     has a clean date on every single record.
//
//  2. THE OBVIOUS FIX IS THE WRONG ONE. MangaDex carries BOTH `publishAt` and `readableAt`.
//     `publishAt` is a *scheduling* field — when the chapter becomes visible on mangadex.org — and
//     for a chapter MangaDex indexes but never hosts (MangaPlus / Webnovel stubs) that moment never
//     arrives, so MangaDex parks it on the far-future sentinel `2037-12-31T15:00:00+00:00`.
//     Measured live 2026-08-14 over `/chapter?order[publishAt]=desc`: 464 of 1000 sampled chapters
//     carried the 2037 sentinel in `publishAt`, every one of them alongside a sane `readableAt`.
//     Takopii no Genzai ch.1-3 are the reproduction used below, and they arrive through the
//     provider's OWN feed query (`translatedLanguage[]=en`), so this is reachable here rather than
//     a curiosity of some other endpoint. Reading `publishAt` would print "2037" next to exactly
//     the chapters a reader cannot open.
//
//     Because the two agree wherever nothing is delayed (all 425 Berserk chapters have
//     `publishAt === readableAt`), a fix validated only on Berserk cannot tell the choice apart.
//     The sentinel fixture below is the discriminator: it fails for `publishAt`, passes for
//     `readableAt`.
//
//  3. THE SHAPE. `IMangaChapter.releaseDate` is a **string**, not a number, and the tree's one date
//     format is ISO-8601 (see `asIsoDate` in flamescans.ts). MangaDex answers with a `+00:00`
//     offset; the provider normalises through `toISOString()` so every provider emits one format,
//     and drops an unparseable value rather than handing a client something `new Date()` chokes on.
//
//  4. `translatedLanguage` was absent for the same reason `releaseDate` was — the aggregator reads
//     `lang | language | translatedLanguage` off each chapter, MangaDex emitted none, and the
//     aggregator's `langModel: 'per-chapter'` trait for MangaDex silently degraded to stamping the
//     language from the registry. Same class of bug, same file, so it is asserted here too.
//
// Offline: every HTTP call is served by a fake axios adapter installed on the provider's own axios
// instance. No network. Live checking is what the ts-node probe is for.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/manga/mangadex.js');
const MangaDex = mod.default ?? mod;

/** axios adapter over a {url-substring → body} map, longest match wins. */
const fakeAdapter = routes => async config => {
  const url = config.url;
  const hit = Object.keys(routes)
    .filter(k => url.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (hit === undefined) throw new Error(`ECONNREFUSED ${url}`);
  return { data: routes[hit], status: 200, statusText: 'OK', headers: {}, config };
};

const provider = routes => {
  const p = new MangaDex();
  p.client.defaults.adapter = fakeAdapter(routes);
  return p;
};

const COVER = { result: 'ok', data: { attributes: { fileName: 'cover.jpg' } } };

const mangaDoc = id => ({
  result: 'ok',
  data: {
    id,
    attributes: {
      title: { 'ja-ro': 'Berserk' },
      altTitles: [{ en: 'Berserk' }],
      description: { en: 'desc' },
      tags: [],
      status: 'ongoing',
      year: 1989,
    },
    relationships: [{ type: 'cover_art', id: 'cov-1' }],
  },
});

/** total <= 96 so fetchAllChapters stops after this single response */
const feed = chapters => ({ result: 'ok', data: chapters, limit: 96, offset: 0, total: chapters.length });

/** a chapter record shaped exactly like the live `/manga/{id}/feed` payload */
const chapterRec = (id, { chapter, pages = 20, externalUrl = null, publishAt, readableAt, lang = 'en' }) => ({
  id,
  attributes: {
    volume: '1',
    chapter,
    title: `Chapter ${chapter}`,
    translatedLanguage: lang,
    externalUrl,
    pages,
    publishAt,
    readableAt,
    createdAt: readableAt,
    updatedAt: readableAt,
  },
});

const routesFor = (id, chapters) => ({
  [`/manga/${id}/feed`]: feed(chapters),
  [`/manga/${id}`]: mangaDoc(id),
  '/cover/cov-1': COVER,
});

/** canonical ISO-8601 UTC, i.e. what `new Date(...).toISOString()` produces */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const BERSERK = '801513ba-a712-498c-8f57-cae55b38cc92';
const TAKOPII = '162146eb-672a-4a05-b3b2-0c6303f9614e';

// Three real Berserk records, values copied verbatim from the live feed on 2026-08-14.
const BERSERK_CHAPTERS = [
  chapterRec('d5431b60-a7c2-49b5-ac5c-872d02ab05c8', {
    chapter: '386',
    pages: 25,
    publishAt: '2026-07-09T19:06:25+00:00',
    readableAt: '2026-07-09T19:06:25+00:00',
  }),
  chapterRec('b1-385', {
    chapter: '385',
    pages: 22,
    publishAt: '2026-06-26T02:33:59+00:00',
    readableAt: '2026-06-26T02:33:59+00:00',
  }),
  chapterRec('b1-0.01', {
    chapter: '0.01',
    pages: 40,
    publishAt: '2018-01-31T07:07:06+00:00',
    readableAt: '2018-01-31T07:07:06+00:00',
  }),
];

// Takopii no Genzai's three English chapters: MangaPlus stubs whose `publishAt` is the sentinel.
// Verbatim from the live feed on 2026-08-14.
const TAKOPII_CHAPTERS = ['1', '2', '3'].map((n, i) =>
  chapterRec(`takopii-${n}`, {
    chapter: n,
    pages: 0,
    externalUrl: `https://mangaplus.shueisha.co.jp/viewer/101289${i}`,
    publishAt: '2037-12-31T15:00:00+00:00',
    readableAt: `2022-02-24T17:57:0${i}+00:00`,
  })
);

// ------------------------------------------------------------------ 1. the field is populated

describe('MangaDex populates releaseDate on every chapter', () => {
  test('every chapter has a NON-EMPTY, parseable, plausible date — not merely the key', async () => {
    const info = await provider(routesFor(BERSERK, BERSERK_CHAPTERS)).fetchMangaInfo(BERSERK);
    assert.equal(info.chapters.length, 3);

    for (const c of info.chapters) {
      // deliberately not `'releaseDate' in c` — that passed against the bug
      assert.equal(typeof c.releaseDate, 'string', `chapter ${c.chapterNumber}: releaseDate must be a string`);
      assert.notEqual(c.releaseDate, '', `chapter ${c.chapterNumber}: releaseDate must not be empty`);

      const ms = Date.parse(c.releaseDate);
      assert.ok(!Number.isNaN(ms), `chapter ${c.chapterNumber}: "${c.releaseDate}" must parse as a date`);

      // plausible = inside the window in which MangaDex has existed and no later than "now".
      // 2037 sentinels and 1970 epoch-zero both fail this.
      const year = new Date(ms).getUTCFullYear();
      assert.ok(year >= 2010, `chapter ${c.chapterNumber}: year ${year} predates MangaDex`);
      assert.ok(
        ms <= Date.now() + 24 * 60 * 60 * 1000,
        `chapter ${c.chapterNumber}: "${c.releaseDate}" is in the future`
      );
    }
  });

  test('the dates are the RIGHT dates, per chapter, not one value smeared across the list', async () => {
    const info = await provider(routesFor(BERSERK, BERSERK_CHAPTERS)).fetchMangaInfo(BERSERK);
    const byNumber = Object.fromEntries(info.chapters.map(c => [c.chapterNumber, c.releaseDate]));
    assert.equal(byNumber['386'], '2026-07-09T19:06:25.000Z');
    assert.equal(byNumber['385'], '2026-06-26T02:33:59.000Z');
    assert.equal(byNumber['0.01'], '2018-01-31T07:07:06.000Z');
  });

  test('releaseDate is a STRING in canonical ISO-8601 UTC, matching the rest of the tree', async () => {
    const info = await provider(routesFor(BERSERK, BERSERK_CHAPTERS)).fetchMangaInfo(BERSERK);
    for (const c of info.chapters) {
      assert.notEqual(typeof c.releaseDate, 'number', 'IMangaChapter.releaseDate is a string, not a number');
      // MangaDex answers "+00:00"; the provider normalises to the "Z" form flamescans also emits
      assert.match(c.releaseDate, ISO_UTC, `"${c.releaseDate}" is not canonical ISO-8601 UTC`);
    }
  });
});

// ---------------------------------------------- 2. readableAt, not publishAt (the discriminator)

describe('MangaDex reads `readableAt`, never the `publishAt` scheduling sentinel', () => {
  test('an external stub whose publishAt is 2037-12-31 reports its real 2022 readableAt', async () => {
    const info = await provider(routesFor(TAKOPII, TAKOPII_CHAPTERS)).fetchMangaInfo(TAKOPII);
    assert.equal(info.chapters.length, 3);

    for (const c of info.chapters) {
      assert.ok(
        !c.releaseDate.startsWith('2037'),
        `chapter ${c.chapterNumber}: got the publishAt sentinel "${c.releaseDate}" — that is the ` +
          `date MangaDex uses for "never publishes here", not a date to show a reader`
      );
      assert.equal(new Date(c.releaseDate).getUTCFullYear(), 2022);
      // and these are precisely the chapters a reader CANNOT open, which is why a 2037 date here
      // would be maximally misleading
      assert.equal(c.readable, false);
    }

    const byNumber = Object.fromEntries(info.chapters.map(c => [c.chapterNumber, c.releaseDate]));
    assert.equal(byNumber['1'], '2022-02-24T17:57:00.000Z');
    assert.equal(byNumber['2'], '2022-02-24T17:57:01.000Z');
    assert.equal(byNumber['3'], '2022-02-24T17:57:02.000Z');
  });

  test('publishAt is ignored even when it is the only *plausible-looking* value present', async () => {
    // A chapter carrying publishAt but no readableAt must yield undefined rather than quietly
    // falling back — the fallback is what would reintroduce the sentinel on the stub chapters.
    const chapters = [
      chapterRec('no-readable', {
        chapter: '7',
        publishAt: '2023-05-05T00:00:00+00:00',
        readableAt: undefined,
      }),
    ];
    const info = await provider(routesFor(BERSERK, chapters)).fetchMangaInfo(BERSERK);
    assert.equal(info.chapters[0].releaseDate, undefined);
  });
});

// ------------------------------------------------------------------------- 3. degenerate inputs

describe('MangaDex never emits a junk date', () => {
  test('a missing, empty or unparseable readableAt yields undefined, not "Invalid Date"', async () => {
    const chapters = [
      chapterRec('absent', { chapter: '1', readableAt: undefined, publishAt: undefined }),
      chapterRec('empty', { chapter: '2', readableAt: '', publishAt: '' }),
      chapterRec('garbage', { chapter: '3', readableAt: 'not a date', publishAt: 'not a date' }),
      chapterRec('numeric', { chapter: '4', readableAt: 1645725420, publishAt: 1645725420 }),
    ];
    const info = await provider(routesFor(BERSERK, chapters)).fetchMangaInfo(BERSERK);
    assert.equal(info.chapters.length, 4);
    for (const c of info.chapters) {
      assert.equal(c.releaseDate, undefined, `chapter ${c.chapterNumber} should have no date`);
      assert.notEqual(String(c.releaseDate), 'Invalid Date');
    }
  });
});

// ------------------------------------------------- 4. the sibling gap: translatedLanguage

describe('MangaDex surfaces the per-chapter translatedLanguage the aggregator looks for', () => {
  test('each chapter carries its own language, so `langModel: per-chapter` is a fact', async () => {
    const info = await provider(routesFor(BERSERK, BERSERK_CHAPTERS)).fetchMangaInfo(BERSERK);
    for (const c of info.chapters) assert.equal(c.translatedLanguage, 'en');
  });

  test('a chapter with no language attribute yields undefined rather than an empty string', async () => {
    const chapters = [chapterRec('nolang', { chapter: '1', readableAt: '2022-01-01T00:00:00+00:00', lang: '' })];
    const info = await provider(routesFor(BERSERK, chapters)).fetchMangaInfo(BERSERK);
    assert.equal(info.chapters[0].translatedLanguage, undefined);
  });
});
