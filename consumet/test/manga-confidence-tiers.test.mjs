// MangaAggregator confidence tiers — the honest replacement for episode-count verification.
//
// WHY THIS SUITE EXISTS. AnimeAggregator proves a match with an episode count (+/-3) plus a
// season/year check. Manga has no equivalent and CANNOT be given one: AniList returns
// `chapters: null` AND `volumes: null` for every RELEASING series — re-confirmed live 2026-08-14
// against manga id 30013 (One Piece) — so a count backstop is absent exactly where wrong-match risk
// is highest, and where a count does exist it agrees with the "Official Colored" re-release it
// would be asked to reject. What replaced it is three labelled tiers:
//
//   'exact-id'   — an id bridge named the provider id outright (B2: MangaDex links.al, MAL-Sync).
//   'metadata'   — the provider's own PRIMARY title matches exactly AND it publishes a
//                  corroborating start year or manga/manhwa/manhua origin, with no contradiction.
//   'unverified' — title similarity alone. Served, but LABELLED.
//
// WHAT IS PINNED HERE, all of it cheap to break silently:
//
//   1. A GENUINE PROMOTION STILL HAPPENS. A tier that never fires is not honesty, it is a
//      regression dressed as caution.
//   2. THE LIGHT NOVEL STAYS 'unverified'. Live 2026-08-14, MangaPill's top hit for "Solo Leveling"
//      is "Solo Leveling Novel" — the light novel, not the manhwa (the manhwa is not in its top
//      five at all). MangaPill also has NO MAL-Sync coverage, so a label is the only defence there
//      is. If a future heuristic promotes that row, the heuristic is wrong.
//   3. A RE-RELEASE NEVER BEATS THE BASE RECORD. Both the "(Official Colored)" case (MangaDex, real
//      rows, and a real 1.0-vs-1.0 title-score TIE through a shared Korean alt title) and the
//      "(Volume)" case (WeebCentral, where BOTH records report year 2018 so the year signal cannot
//      separate them at all).
//   4. A THROWING CLASSIFIER IS SWALLOWED AND THE CANDIDATE STAYS 'unverified'. This is the safety
//      property: a bug in a heuristic must never be able to manufacture confidence. It is
//      mutation-tested — delete the try/catch in `rankedFor` and these tests THROW instead of
//      asserting. The clamp is tested too: only 'metadata' promotes, so a classifier returning
//      'exact-id' (a bridge's answer, never a heuristic's) is refused and logged.
//   5. 'exact-id' FROM B2 STILL OUTRANKS ANYTHING THE CLASSIFIER PRODUCES, and still skips the
//      provider search entirely.
//   6. NO CHAPTER OR VOLUME COUNT IS READ. MangaDex ships `lastChapter`/`lastVolume` and AsuraScans
//      ships `chapterCount`/`latestChapter` in the very search results this classifier reads. The
//      refusal is asserted by mutating those fields to nonsense and requiring the verdict not to
//      move.
//
// Every fixture below is a trimmed copy of a LIVE response captured 2026-08-14, and each carries
// the query that produced it. Offline: providers are duck-typed fakes injected through the
// constructor and the metadata resolver is injected too, so no test here touches the network.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const aggMod = require('../dist/providers/meta/manga-aggregator.js');
const MangaAggregator = aggMod.default ?? aggMod;
const { unverifiedClassifier, MANGA_CONFIDENCE_RANK } = aggMod;
const clsMod = require('../dist/providers/meta/manga-classifier.js');
const {
  MetadataMatchClassifier,
  createMangaMatchClassifier,
  describeMangaMatchClassifier,
  normalizeTitle,
  MANGA_CLASSIFIER_SIGNAL_COVERAGE,
} = clsMod;

/** Swallow the diagnostic logs and hand them back, so tests can assert on them. */
const capture = async fn => {
  const logs = [];
  const { warn, error } = console;
  console.warn = (...a) => logs.push(String(a[0]));
  console.error = (...a) => logs.push(String(a[0]));
  try {
    return { out: await fn(), logs };
  } finally {
    console.warn = warn;
    console.error = error;
  }
};

// =============================================================================================
// FIXTURES — AniList, captured live 2026-08-14 via Media(id, type: MANGA)
// =============================================================================================

/**
 * One Piece. Note `chapters: null` and `volumes: null` on a RELEASING series — the whole reason
 * this suite exists. Synonyms are AniList's own, trimmed; '원피스' is kept because it is what
 * creates the real title-score tie in the re-release test below.
 */
const ONE_PIECE = {
  anilistId: '30013',
  titles: ['One Piece', 'ONE PIECE', 'ワンピース', '원피스'],
  malId: 13,
  chapters: undefined,
  volumes: undefined,
  startYear: 1997,
  countryOfOrigin: 'JP',
  format: 'MANGA',
  status: 'RELEASING',
};

/** Solo Leveling. FINISHED, so AniList DOES give a count here — and it is still not used. */
const SOLO = {
  anilistId: '105398',
  titles: ['Solo Leveling', 'Na Honjaman Level Up', '나 혼자만 레벨업', 'Only I Level Up', 'I Level Up Alone'],
  malId: 121496,
  chapters: 201,
  volumes: 15,
  startYear: 2018,
  countryOfOrigin: 'KR',
  format: 'MANGA',
  status: 'FINISHED',
};

// =============================================================================================
// FIXTURES — provider search rows, captured live 2026-08-14
// =============================================================================================

/**
 * `MangaDex.search('One Piece')` rows 1 and 6, in the provider's own emitted shape
 * (`releaseDate: attributes.year`, `altTitles` verbatim as [{lang: title}]).
 *
 * THE ALT TITLES ARE THE POINT. Both records carry a Korean alt '원피스', which is also an AniList
 * synonym — so the aggregator's cross-product title score is 1.0 for BOTH and cannot separate them.
 * `lastChapter`/`lastVolume` are included exactly as MangaDex ships them, to prove they are ignored.
 */
const MD_ONE_PIECE_BASE = {
  id: 'a1c7c817-4e59-43b7-9365-09675a149a6f',
  title: 'One Piece',
  altTitles: [{ ja: 'ワンピース' }, { ko: '원피스' }, { zh: '海贼王' }],
  status: 'ongoing',
  releaseDate: 1997,
  lastChapter: null,
  lastVolume: null,
};

const MD_ONE_PIECE_COLORED = {
  id: 'a2c1d849-af05-4bbc-b2a7-866ebb10331f',
  title: 'One Piece (Official Colored)',
  altTitles: [{ ko: '원피스' }, { zh: '海贼王' }, { ja: 'ONE PIECE カラー版' }, { en: 'One Piece - Digital Colored Comics' }],
  status: 'ongoing',
  releaseDate: 2012,
};

/** `MangaDex.search('Solo Leveling')` — rows 2 and 1. MangaDex's OWN ranking puts the sequel first. */
const MD_SOLO_CANONICAL = {
  id: '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0',
  // The canonical record's only primary title is a Korean romanisation. No title method reaches it
  // from "Solo Leveling" — the aggregator gets there through the `en` alt title.
  title: 'Na Honjaman Level-Up',
  altTitles: [{ en: 'Solo Leveling' }, { la: 'Solo Adtritio' }, { 'pt-br': 'Jogador solo' }],
  status: 'completed',
  releaseDate: 2018,
};

const MD_SOLO_SEQUEL = {
  id: 'ade0306c-f4b6-4890-9edb-1ddf04df2039',
  title: 'Na Honjaman Level Up: Ragnarok',
  altTitles: [{ en: 'Solo Leveling: Ragnarok' }],
  status: 'hiatus',
  releaseDate: 2024,
};

/**
 * `MangaPill.search('Solo Leveling')` — the real top two, verbatim. The manhwa is NOT in the top
 * five. MangaPill emits no year and no type, which is why tier 2 is structurally unreachable for it.
 */
const PILL_SOLO_NOVEL = {
  id: '8136/solo-leveling-novel',
  title: 'Solo Leveling Novel',
  image: 'https://cdn.readdetectiveconan.com/file/mangapill/i/8136.jpeg',
  altTitles: 'Solo Leveling Official Light Novel',
};

const PILL_SOLO_RAGNAROK_NOVEL = {
  id: '8202/solo-leveling-ragnarok-novel',
  title: 'Solo Leveling: Ragnarok Novel',
  altTitles: 'Solo Leveling: Ragnarok Light Novel',
};

/**
 * `AsuraScans.search('Solo Leveling')` — rows 1 and 2. AsuraScans' own ranking ALSO puts the sequel
 * first. It emits `type` but no year, and it emits `chapterCount`/`latestChapter`, which are
 * deliberately unread. Alt titles are trimmed to the load-bearing ones — note that the BASE record
 * lists "Solo Leveling: Arise", a DIFFERENT series, among its alts. That is why an alt title can
 * rank a candidate but must never promote one.
 */
const ASURA_SOLO_SEQUEL = {
  id: 'solo-leveling-ragnarok',
  title: 'Solo Leveling: Ragnarok',
  altTitles: ['Na Honjaman Level Up: Ragnarok', 'Only I Level Up: Ragnarok', 'Solo Leveling: Ragnarök'],
  status: 'Hiatus',
  type: 'manhwa',
  chapterCount: 68,
  latestChapter: '68',
};

const ASURA_SOLO_BASE = {
  id: 'solo-leveling',
  title: 'Solo Leveling',
  altTitles: ['Na Honjaman Level Up', 'Only I Level Up', 'Solo Leveling: Arise', '나 혼자만 레벨업'],
  status: 'Completed',
  type: 'manhwa',
  chapterCount: 201,
  latestChapter: '200',
};

/** `FlameComics.search('Solo Leveling')` — the only provider that supplies BOTH year and type. */
const FLAME_SOLO_BASE = {
  id: '1',
  title: 'Solo Leveling',
  status: 'Completed',
  type: 'Manhwa',
  releaseDate: 2018,
  genres: ['Action', 'Adventure', 'Fantasy', 'Shounen'],
};

const FLAME_SOLO_SEQUEL = {
  id: '143',
  title: 'Solo Leveling: Ragnarok',
  status: 'Hiatus',
  type: 'Manhwa',
  releaseDate: 2024,
  genres: ['Action', 'Adventure', 'Fantasy', 'Shounen'],
};

/**
 * `WeebCentral.search('Solo Leveling')` — rows 1 and 2. The re-release case the YEAR CANNOT SOLVE:
 * both report releaseDate "2018" and status Completed. Only the bracketed qualifier separates them.
 */
const WEEB_SOLO_BASE = {
  id: '01J76XYCPSY3C4BNPBRY8JMCBE',
  title: 'Solo Leveling',
  status: 'Completed',
  releaseDate: '2018',
  genres: ['Action', 'Adventure', 'Fantasy', 'Shounen'],
};

const WEEB_SOLO_VOLUME = {
  id: '01J76XYEJVJ5H6AXPYWS4G0CFV',
  title: 'Solo Leveling (Volume)',
  status: 'Completed',
  releaseDate: '2018',
  genres: ['Action', 'Adventure', 'Fantasy', 'Shounen', 'Supernatural'],
};

/** `MangaHere.search('One Piece')`-shaped: id, title, image, description, status. Nothing else. */
const HERE_ONE_PIECE = {
  id: 'one_piece',
  title: 'One Piece',
  status: 'Ongoing',
  description: 'Gold Roger was known as the Pirate King...',
};

// =============================================================================================
// HELPERS
// =============================================================================================

/** A duck-typed provider. The registry has to accept one, or only the six real ones are testable. */
const fake = (name, results, impl = {}) => ({
  parser: {
    name,
    calls: [],
    async search(q, page, limit) {
      this.calls.push(`search:${q}:${page}:${limit}`);
      return { results };
    },
    async fetchMangaInfo(id) {
      this.calls.push(`info:${id}`);
      return { id, title: name, chapters: impl.chapters ?? [{ id: `${id}#1`, title: 'Chapter 1' }] };
    },
    async fetchChapterPages() {
      return [];
    },
  },
});

/** An aggregator with bridges OFF, so the classifier is the only thing deciding a tier. */
const aggregator = (providers, meta, options = {}) =>
  new MangaAggregator({ providers, metadata: { resolve: async () => meta }, bridges: [], ...options });

const classifier = new MetadataMatchClassifier();
const verdict = (provider, row, meta) =>
  classifier.explain({ provider, id: row.id, title: row.title, score: 1, raw: row }, meta);

// =============================================================================================
describe('tier 2 fires: a corroborated match is promoted to metadata', () => {
  test('FlameComics Solo Leveling — exact primary title + year 2018 + type Manhwa', () => {
    const e = verdict('FlameComics', FLAME_SOLO_BASE, SOLO);
    assert.equal(e.confidence, 'metadata');
    assert.equal(e.exactPrimaryTitle, true);
    assert.deepEqual(
      e.signals.map(s => s.field).sort(),
      ['type', 'year'],
      `both independent fields must count exactly once: ${JSON.stringify(e.signals)}`
    );
    assert.deepEqual(e.vetoes, []);
  });

  test('WeebCentral Solo Leveling — exact primary title + year alone is enough', () => {
    const e = verdict('WeebCentral', WEEB_SOLO_BASE, SOLO);
    assert.equal(e.confidence, 'metadata');
    assert.deepEqual(e.signals.map(s => s.field), ['year']);
  });

  test('AsuraScans Solo Leveling — exact primary title + the manhwa/KR axis, with no year at all', () => {
    const e = verdict('AsuraScans', ASURA_SOLO_BASE, SOLO);
    assert.equal(e.confidence, 'metadata');
    assert.deepEqual(e.signals.map(s => s.field), ['type']);
    assert.ok(
      e.signals[0].detail.includes('KR'),
      `the signal must name the axis it matched on: ${e.signals[0].detail}`
    );
  });

  test('MangaDex reaches the canonical record through an ALT title and is then promoted on year', () => {
    // The record's only primary title is 'Na Honjaman Level-Up'. AniList's romaji is
    // 'Na Honjaman Level Up' — a hyphen apart — so the promotion rides on title NORMALISATION, not
    // on a tuned similarity threshold.
    assert.equal(normalizeTitle('Na Honjaman Level-Up'), normalizeTitle('Na Honjaman Level Up'));
    const e = verdict('MangaDex', MD_SOLO_CANONICAL, SOLO);
    assert.equal(e.confidence, 'metadata');
    assert.equal(e.exactPrimaryTitle, true);
  });

  test('the promotion reaches the aggregator envelope, on getMappings AND getChapters', async () => {
    const flame = fake('FlameComics', [FLAME_SOLO_BASE]);
    const agg = aggregator([flame], SOLO);
    const { out } = await capture(() => agg.getMappings(105398));
    assert.equal(out.length, 1);
    assert.equal(out[0].matchConfidence, 'metadata');
    assert.equal(out[0].via, undefined, "'via' belongs to id bridges only");

    const { out: chapters } = await capture(() => agg.getChapters(105398));
    assert.equal(chapters.matchConfidence, 'metadata');
    assert.equal(chapters.providerId, '1');
  });
});

// =============================================================================================
describe('tier 3 stays tier 3: the measured failure modes are labelled, not promoted', () => {
  test("MangaPill's light novel — the top live hit for 'Solo Leveling' — stays unverified", () => {
    const e = verdict('MangaPill', PILL_SOLO_NOVEL, SOLO);
    assert.equal(e.confidence, 'unverified', 'promoting the light novel is the failure this exists to stop');
    assert.ok(
      e.vetoes.some(v => v.field === 'title' && /novel/i.test(v.detail)),
      `the novel veto must be the reason, not an accident of scoring: ${JSON.stringify(e.vetoes)}`
    );
    assert.equal(verdict('MangaPill', PILL_SOLO_RAGNAROK_NOVEL, SOLO).confidence, 'unverified');
  });

  test('the novel veto lifts when AniList itself says format NOVEL', () => {
    // Correctness in the other direction: a caller asking for the light novel must still be able to
    // reach it. The veto is about DISAGREEMENT, not about the word "novel".
    const asNovel = { ...SOLO, format: 'NOVEL', titles: ['Solo Leveling Novel', 'Solo Leveling'] };
    const e = classifier.explain(
      { provider: 'MangaPill', id: PILL_SOLO_NOVEL.id, title: PILL_SOLO_NOVEL.title, score: 1, raw: { ...PILL_SOLO_NOVEL, releaseDate: 2018 } },
      asNovel
    );
    assert.deepEqual(e.vetoes, [], `format NOVEL must exempt a "Novel" title: ${JSON.stringify(e.vetoes)}`);
    assert.equal(e.confidence, 'metadata');
  });

  test('a PERFECT title on a provider that states nothing else is still only unverified', () => {
    // MangaPill has no year, no type and no MAL-Sync coverage. A 1.0 title score is exactly what
    // tier 3 IS, so this must not slide upward just because the string happens to be identical.
    const e = verdict('MangaPill', { id: 'x/solo-leveling', title: 'Solo Leveling', altTitles: 'Na Honjaman Level Up' }, SOLO);
    assert.equal(e.confidence, 'unverified');
    assert.equal(e.exactPrimaryTitle, true);
    assert.deepEqual(e.signals, []);
    assert.deepEqual(e.vetoes, []);
    assert.match(e.rule, /NO corroborating field/);
  });

  test('MangaHere states nothing either — tier 2 is structurally unreachable for it', () => {
    const e = verdict('MangaHere', HERE_ONE_PIECE, ONE_PIECE);
    assert.equal(e.confidence, 'unverified');
    assert.deepEqual(e.signals, []);
  });

  test('a sequel that both MangaDex and AsuraScans rank FIRST is not promoted', () => {
    // Two providers, two rankings, same wrong answer at position 1. MangaDex is caught by the year
    // (2024 vs 2018); AsuraScans publishes no year at all and is caught by falling short of both
    // promotion rules with its single signal.
    const md = verdict('MangaDex', MD_SOLO_SEQUEL, SOLO);
    assert.equal(md.confidence, 'unverified');
    assert.ok(md.vetoes.some(v => v.field === 'year'));

    const asura = verdict('AsuraScans', ASURA_SOLO_SEQUEL, SOLO);
    assert.equal(asura.confidence, 'unverified');
    assert.deepEqual(asura.vetoes, [], 'nothing CONTRADICTS here — it simply is not corroborated');
    assert.ok(asura.primaryScore < 0.85, `sequel scored ${asura.primaryScore} on title alone`);
  });

  test('the manga/manhwa/manhua axis vetoes a wrong-origin record outright', () => {
    const e = verdict('AsuraScans', { id: 'one-piece', title: 'One Piece', type: 'manhwa' }, ONE_PIECE);
    assert.equal(e.confidence, 'unverified');
    assert.ok(e.vetoes.some(v => v.field === 'type' && v.detail.includes('JP')));
    // …and 'manhua' agrees with BOTH CN and TW, because nothing downstream can tell them apart.
    const cn = { ...ONE_PIECE, countryOfOrigin: 'TW', titles: ['X'] };
    const tw = classifier.explain({ provider: 'p', id: 'x', title: 'X', score: 1, raw: { type: 'manhua' } }, cn);
    assert.deepEqual(tw.vetoes, []);
    assert.deepEqual(tw.signals.map(s => s.field), ['type']);
  });

  test('an alt-title match ranks a candidate but can never promote one', () => {
    // Captured live: AsuraScans' BASE "Solo Leveling" record lists "Solo Leveling: Arise" — a
    // different series — among its alt titles. Equality is therefore tested against the provider's
    // PRIMARY title only.
    assert.ok(ASURA_SOLO_BASE.altTitles.includes('Solo Leveling: Arise'));
    const askingForArise = { ...SOLO, anilistId: '999999', titles: ['Solo Leveling: Arise'], startYear: 2024 };
    const e = verdict('AsuraScans', ASURA_SOLO_BASE, askingForArise);
    assert.equal(e.exactPrimaryTitle, false, 'the equality must not come from an alt title');
    assert.equal(e.confidence, 'unverified');
  });
});

// =============================================================================================
describe('a re-release never beats the base record', () => {
  test('MangaDex: "(Official Colored)" is vetoed where the base record is promoted', () => {
    const base = verdict('MangaDex', MD_ONE_PIECE_BASE, ONE_PIECE);
    assert.equal(base.confidence, 'metadata');

    const colored = verdict('MangaDex', MD_ONE_PIECE_COLORED, ONE_PIECE);
    assert.equal(colored.confidence, 'unverified');
    assert.ok(
      colored.vetoes.some(v => v.field === 'title'),
      'the bracketed qualifier must fire on its own — the year is a second, independent catch'
    );
    assert.ok(colored.vetoes.some(v => v.field === 'year' && v.detail.includes('2012')));
  });

  test('…and the aggregator hands back the base record even when the provider ranks it SECOND', async () => {
    // THE TITLE SCORES TIE AT 1.0. Both MangaDex records carry the Korean alt '원피스', which is
    // also an AniList synonym, so the aggregator's cross-product similarity cannot separate them —
    // and MangaDex's own relevance ranking is untrustworthy here (live, it ranks the Solo Leveling
    // SEQUEL first). Confidence-first ordering is what makes the answer not a coin flip.
    const md = fake('MangaDex', [MD_ONE_PIECE_COLORED, MD_ONE_PIECE_BASE]);
    const { out } = await capture(() => aggregator([md], ONE_PIECE).getMappings(30013));
    assert.equal(out[0].id, MD_ONE_PIECE_BASE.id, 'the colour re-release was handed back as the best mapping');
    assert.equal(out[0].matchConfidence, 'metadata');

    // Same ordering must reach getChapters, or the reader still opens the colour edition.
    const md2 = fake('MangaDex', [MD_ONE_PIECE_COLORED, MD_ONE_PIECE_BASE]);
    const { out: chapters } = await capture(() => aggregator([md2], ONE_PIECE).getChapters(30013));
    assert.equal(chapters.providerId, MD_ONE_PIECE_BASE.id);
    assert.equal(chapters.matchConfidence, 'metadata');
  });

  test('WeebCentral "(Volume)": the year is IDENTICAL, so only the qualifier separates them', async () => {
    assert.equal(WEEB_SOLO_BASE.releaseDate, WEEB_SOLO_VOLUME.releaseDate, 'fixture drift — the shared year is the point');

    const base = verdict('WeebCentral', WEEB_SOLO_BASE, SOLO);
    const volume = verdict('WeebCentral', WEEB_SOLO_VOLUME, SOLO);
    assert.equal(base.confidence, 'metadata');
    assert.equal(volume.confidence, 'unverified');
    assert.ok(volume.signals.some(s => s.field === 'year'), 'the year AGREES for the re-release — that is the trap');
    assert.ok(volume.vetoes.some(v => v.field === 'title' && v.detail.includes('volume')));

    const weeb = fake('WeebCentral', [WEEB_SOLO_VOLUME, WEEB_SOLO_BASE]);
    const { out } = await capture(() => aggregator([weeb], SOLO).getMappings(105398));
    assert.equal(out[0].id, WEEB_SOLO_BASE.id);
  });

  test('a caller asking FOR the colour edition can still reach it', () => {
    // The veto is "the provider distinguishes this record from what you asked for". If AniList's own
    // titles carry the same marker, nothing is being distinguished.
    const coloured = { ...ONE_PIECE, titles: ['One Piece (Official Colored)', 'One Piece Colored'], startYear: 2012 };
    const e = verdict('MangaDex', MD_ONE_PIECE_COLORED, coloured);
    assert.deepEqual(e.vetoes, [], `asking for the colour edition must not be self-vetoing: ${JSON.stringify(e.vetoes)}`);
    assert.equal(e.confidence, 'metadata');
  });
});

// =============================================================================================
describe('the safety property: a broken classifier can never manufacture confidence', () => {
  test('a THROWING classifier is swallowed and the candidate stays unverified', async () => {
    // MUTATION TEST. Remove the try/catch around `classifier.classify` in `rankedFor` and this does
    // not merely assert a different label — the whole call rejects and the test THROWS.
    const flame = fake('FlameComics', [FLAME_SOLO_BASE]);
    const agg = aggregator([flame], SOLO, {
      classifier: {
        classify: () => {
          throw new Error('classifier bug');
        },
      },
    });
    const { out, logs } = await capture(() => agg.getMappings(105398));
    assert.equal(out.length, 1, 'the call must still answer');
    assert.equal(out[0].matchConfidence, 'unverified');
    assert.ok(logs.some(l => l.includes('classifier threw')), `the bug must be LOGGED, not hidden: ${JSON.stringify(logs)}`);
  });

  test('a classifier that throws asynchronously is swallowed the same way', async () => {
    const agg = aggregator([fake('FlameComics', [FLAME_SOLO_BASE])], SOLO, {
      classifier: { classify: async () => Promise.reject(new Error('async bug')) },
    });
    const { out } = await capture(() => agg.getMappings(105398));
    assert.equal(out[0].matchConfidence, 'unverified');
  });

  test('a classifier that throws on ONE candidate does not poison the others', async () => {
    const md = fake('MangaDex', [MD_ONE_PIECE_COLORED, MD_ONE_PIECE_BASE]);
    const agg = aggregator([md], ONE_PIECE, {
      classifier: {
        classify: c => {
          if (c.id === MD_ONE_PIECE_COLORED.id) throw new Error('boom');
          return 'metadata';
        },
      },
    });
    const { out } = await capture(() => agg.getMappings(30013));
    assert.equal(out[0].id, MD_ONE_PIECE_BASE.id);
    assert.equal(out[0].matchConfidence, 'metadata');
  });

  test("only 'metadata' promotes — a classifier claiming 'exact-id' is refused and logged", async () => {
    // 'exact-id' means "an id bridge named this provider id outright". A heuristic cannot know that,
    // and a mapping carrying that tier with no `via` is not explainable by anything downstream.
    const agg = aggregator([fake('FlameComics', [FLAME_SOLO_BASE])], SOLO, {
      classifier: { classify: () => 'exact-id' },
    });
    const { out, logs } = await capture(() => agg.getMappings(105398));
    assert.equal(out[0].matchConfidence, 'unverified');
    assert.equal(out[0].via, undefined);
    assert.ok(logs.some(l => l.includes('only') && l.includes('may promote')), JSON.stringify(logs));

    // and any nonsense lands on the honest label too
    const junk = aggregator([fake('FlameComics', [FLAME_SOLO_BASE])], SOLO, { classifier: { classify: () => 'banana' } });
    assert.equal((await capture(() => junk.getMappings(105398))).out[0].matchConfidence, 'unverified');
  });

  test('unverifiedClassifier is still the one-line opt-out of tier 2', async () => {
    const agg = aggregator([fake('FlameComics', [FLAME_SOLO_BASE])], SOLO, { classifier: unverifiedClassifier });
    assert.equal((await capture(() => agg.getMappings(105398))).out[0].matchConfidence, 'unverified');
  });

  test('the default classifier really is installed — no injection needed', async () => {
    const agg = new MangaAggregator({
      providers: [fake('FlameComics', [FLAME_SOLO_BASE])],
      metadata: { resolve: async () => SOLO },
      bridges: [],
    });
    assert.ok(agg.classifier instanceof MetadataMatchClassifier);
    assert.equal((await capture(() => agg.getMappings(105398))).out[0].matchConfidence, 'metadata');
  });
});

// =============================================================================================
describe("B2's exact-id still outranks anything B3 can produce", () => {
  test('a bridge wins, keeps its via, and the provider search is never issued', async () => {
    // FlameComics' row here would be promoted to 'metadata' on its own merits, so this is a real
    // contest between the tiers rather than a walkover.
    assert.equal(verdict('FlameComics', FLAME_SOLO_BASE, SOLO).confidence, 'metadata');

    const flame = fake('FlameComics', [FLAME_SOLO_BASE]);
    const agg = new MangaAggregator({
      providers: [flame],
      metadata: { resolve: async () => SOLO },
      bridges: [{ name: 'malsync', via: 'malsync', lookup: async () => 'bridged-id' }],
    });
    const { out } = await capture(() => agg.getMappings(105398));
    assert.equal(out[0].matchConfidence, 'exact-id');
    assert.equal(out[0].via, 'malsync');
    assert.equal(out[0].id, 'bridged-id');
    assert.deepEqual(flame.parser.calls, [], 'a bridge hit must skip the provider search entirely');
  });

  test('across providers, exact-id sorts above metadata sorts above unverified', async () => {
    assert.ok(MANGA_CONFIDENCE_RANK['exact-id'] < MANGA_CONFIDENCE_RANK.metadata);
    assert.ok(MANGA_CONFIDENCE_RANK.metadata < MANGA_CONFIDENCE_RANK.unverified);

    // MangaPill can only be 'unverified'; FlameComics reaches 'metadata'; MangaHere is bridged.
    // All three would otherwise tie or invert on title score alone.
    const agg = new MangaAggregator({
      providers: [
        fake('MangaPill', [{ id: 'x/solo-leveling', title: 'Solo Leveling' }]),
        fake('FlameComics', [FLAME_SOLO_BASE]),
        fake('MangaHere', [{ id: 'solo_leveling', title: 'Solo Leveling' }]),
      ],
      metadata: { resolve: async () => SOLO },
      bridges: [
        { name: 'malsync', via: 'malsync', lookup: async (_m, p) => (p === 'MangaHere' ? 'solo_leveling' : null) },
      ],
    });
    const { out } = await capture(() => agg.getMappings(105398));
    assert.deepEqual(
      out.map(m => `${m.provider}:${m.matchConfidence}`),
      ['MangaHere:exact-id', 'FlameComics:metadata', 'MangaPill:unverified']
    );
  });
});

// =============================================================================================
describe('the refusals are real: no count, no status, no invented backstop', () => {
  test('chapter and volume counts are NOT read, however loudly the provider shouts them', () => {
    // AnimeAggregator's EPISODE_COUNT_TOLERANCE has no port. These fields exist in the very rows
    // the classifier reads, so the refusal has to be asserted rather than assumed.
    const baseline = verdict('AsuraScans', ASURA_SOLO_BASE, SOLO);
    assert.equal(baseline.confidence, 'metadata');
    const lying = verdict(
      'AsuraScans',
      { ...ASURA_SOLO_BASE, chapterCount: 999999, latestChapter: '999999' },
      SOLO
    );
    assert.deepEqual(lying, baseline, 'a chapter count moved the verdict — the fake backstop is back');

    const mdBaseline = verdict('MangaDex', MD_ONE_PIECE_BASE, ONE_PIECE);
    const mdLying = verdict('MangaDex', { ...MD_ONE_PIECE_BASE, lastChapter: '3', lastVolume: '1' }, ONE_PIECE);
    assert.deepEqual(mdLying, mdBaseline);

    // …and the AniList side is inert too, in BOTH directions: null (the RELEASING case) and a real
    // number (the FINISHED case) must classify identically.
    const withCount = verdict('AsuraScans', ASURA_SOLO_BASE, { ...SOLO, chapters: 1, volumes: 1 });
    assert.deepEqual(withCount, baseline);
  });

  test('status is not a signal — it discriminates nothing and would inflate the count', () => {
    // A scanlation site that stopped updating reports Completed for a RELEASING series, and a colour
    // re-release reports the same status as its base record.
    const a = verdict('WeebCentral', WEEB_SOLO_BASE, SOLO);
    const b = verdict('WeebCentral', { ...WEEB_SOLO_BASE, status: 'Ongoing' }, SOLO);
    assert.deepEqual(a.signals, b.signals);
    assert.deepEqual(a.vetoes, b.vetoes);
    assert.equal(a.confidence, b.confidence);
  });

  test('the comic/novel axis is a veto only, never a signal', () => {
    // "This provider record is a comic and AniList says MANGA" is true of essentially every
    // candidate on all six sites, so counting it would inflate the signal count with no information.
    const e = verdict('SomeProvider', { id: 'x', title: 'Solo Leveling', type: 'comic' }, SOLO);
    assert.deepEqual(e.signals, [], 'agreement on "is a comic" must not corroborate anything');
    assert.equal(e.confidence, 'unverified');
    // the same field the other way round IS a veto
    const novel = verdict('SomeProvider', { id: 'x', title: 'Solo Leveling', type: 'light novel' }, SOLO);
    assert.ok(novel.vetoes.some(v => v.field === 'type'));
  });

  test('one provider FIELD is one signal, even when it implies several facts', () => {
    // `type: "manhwa"` implies both "Korean" and "not prose". Counting that twice would let a single
    // field satisfy the two-signal rule on its own.
    const e = verdict('AsuraScans', ASURA_SOLO_BASE, SOLO);
    assert.equal(e.signals.filter(s => s.field === 'type').length, 1);
  });

  test('a contradiction is never outvoted by agreement', () => {
    // Both signals agree AND a qualifier disagrees. Vetoes are absolute on purpose: the cost of a
    // wrong veto is an honest 'unverified'; the cost of a missed one is a confident wrong answer.
    const e = verdict('FlameComics', { ...FLAME_SOLO_BASE, title: 'Solo Leveling (Fan Colored)' }, SOLO);
    assert.equal(e.signals.length, 2);
    assert.equal(e.confidence, 'unverified');
  });

  test('a year within one is agreement; two years apart is a contradiction', () => {
    // 1, not 3: serialisation start dates drift by a magazine issue or a region of first release,
    // and that is a one-year effect.
    for (const [year, expected] of [
      [2017, 'metadata'],
      [2018, 'metadata'],
      [2019, 'metadata'],
      [2020, 'unverified'],
    ])
      assert.equal(
        verdict('WeebCentral', { ...WEEB_SOLO_BASE, releaseDate: String(year) }, SOLO).confidence,
        expected,
        `year ${year} vs startYear 2018`
      );
  });

  test('a missing field is never a signal and never a veto', () => {
    // Absence of evidence is not evidence — a provider that says nothing is exactly tier 3.
    const e = verdict('WeebCentral', { id: 'x', title: 'Solo Leveling' }, SOLO);
    assert.deepEqual(e.signals, []);
    assert.deepEqual(e.vetoes, []);
    // …and the same holds when it is AniList that is silent
    const noMeta = verdict('FlameComics', FLAME_SOLO_BASE, { ...SOLO, startYear: undefined, countryOfOrigin: undefined });
    assert.deepEqual(noMeta.signals, []);
    assert.deepEqual(noMeta.vetoes, []);
    assert.equal(noMeta.confidence, 'unverified');
  });
});

// =============================================================================================
describe('the classifier is total and self-documenting', () => {
  test('garbage in gives unverified out, never a throw', () => {
    const junk = [
      [{ provider: 'p', id: 'x', title: '', score: 0, raw: null }, SOLO],
      [{ provider: 'p', id: 'x', title: 'X', score: 0, raw: undefined }, { anilistId: '1', titles: [] }],
      [{ provider: 'p', id: 'x', title: 'X', score: 0, raw: { releaseDate: {} } }, { anilistId: '1', titles: [null, '', 'X'] }],
      [{ provider: 'p', id: 'x', title: 'X', score: 0, raw: { type: [1, 2, 3], genres: 'not-an-array' } }, SOLO],
    ];
    for (const [candidate, meta] of junk) {
      const e = classifier.explain(candidate, meta);
      assert.ok(['metadata', 'unverified'].includes(e.confidence), `bad verdict for ${JSON.stringify(candidate)}`);
      assert.equal(typeof e.rule, 'string');
    }
    // classify() agrees with explain() and never returns the bridge tier
    for (const row of [MD_ONE_PIECE_BASE, MD_ONE_PIECE_COLORED, PILL_SOLO_NOVEL, ASURA_SOLO_BASE])
      assert.notEqual(
        classifier.classify({ provider: 'p', id: row.id, title: row.title, score: 1, raw: row }, ONE_PIECE),
        'exact-id'
      );
  });

  test('a high-scoring candidate that is vetoed says so out loud', async () => {
    const { logs } = await capture(async () =>
      classifier.classify(
        { provider: 'MangaDex', id: MD_ONE_PIECE_COLORED.id, title: MD_ONE_PIECE_COLORED.title, score: 1, raw: MD_ONE_PIECE_COLORED },
        { ...ONE_PIECE, titles: ['One Piece (Official Colored)'], startYear: 1997 }
      )
    );
    assert.ok(
      logs.some(l => l.includes('was NOT') && l.includes('promoted')),
      `a near-perfect title that is deliberately not promoted is the one case worth logging: ${JSON.stringify(logs)}`
    );
  });

  test('thresholds are constructor-injectable, so tuning is not a source edit', () => {
    const strict = createMangaMatchClassifier({ yearTolerance: 0 });
    assert.equal(
      strict.explain({ provider: 'p', id: 'x', title: 'Solo Leveling', score: 1, raw: { releaseDate: 2019 } }, SOLO).confidence,
      'unverified'
    );
    assert.equal(
      classifier.explain({ provider: 'p', id: 'x', title: 'Solo Leveling', score: 1, raw: { releaseDate: 2019 } }, SOLO).confidence,
      'metadata'
    );
  });

  test('the signal-coverage table names every registered provider and states its limits', () => {
    const registered = new MangaAggregator().providerNames;
    assert.equal(registered.length, 6);
    const covered = MANGA_CLASSIFIER_SIGNAL_COVERAGE.map(c => c.provider);
    for (const name of registered)
      assert.ok(covered.includes(name), `${name} is registered but absent from the coverage table`);
    for (const row of MANGA_CLASSIFIER_SIGNAL_COVERAGE)
      assert.ok(row.note && row.note.length > 20, `${row.provider} has no note — an unexplained row is folklore`);

    // The documented limit, asserted so it cannot rot into an unnoticed claim: two providers supply
    // NO non-title field, so tier 2 is unreachable for them.
    const blind = MANGA_CLASSIFIER_SIGNAL_COVERAGE.filter(c => !c.year && !c.type).map(c => c.provider);
    assert.deepEqual(blind.sort(), ['MangaHere', 'MangaPill']);
  });

  test('the description states what it refuses to do and why', () => {
    const d = describeMangaMatchClassifier();
    assert.deepEqual(d.tiers.map(t => t.tier), ['exact-id', 'metadata', 'unverified']);
    assert.deepEqual(d.signalFields, ['year', 'type']);
    assert.ok(d.refusals.some(r => /chapter/i.test(r) && /volume/i.test(r)), 'the count refusal must be documented');
    assert.ok(d.refusals.some(r => /STATUS IS NOT A SIGNAL/.test(r)));
    assert.ok(d.refusals.some(r => /AUTHOR IS NOT USED/.test(r)));
  });
});
