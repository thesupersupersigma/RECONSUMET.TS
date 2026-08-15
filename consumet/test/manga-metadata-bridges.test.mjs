// The manga metadata layer — AniList primary, MangaDex as verifier, MAL-Sync as id bridge.
//
// WHAT THIS PROTECTS.
//
//   1. `links.al` IS AN ID EQUALITY, NOT A TITLE MATCH — and that is the entire point. The fixture
//      below is the real MangaDex response for Solo Leveling, and it is the perfect adversarial
//      case: the CANONICAL record's only primary title is a Korean romanisation ("Na Honjaman
//      Level-Up") with almost no bigram overlap with "Solo Leveling", while a DECOY record is
//      titled literally "Solo Leveling (Book Version)". Every title-similarity approach picks the
//      decoy. `attributes.links.al === '105398'` picks the right one, because only the canonical
//      record carries `links` at all. Break the comparison and these tests hand back the decoy.
//
//   2. AXIOS DOUBLE-BRACKETS ARRAY PARAMS. MangaDex wants `?ids[]=x&ids[]=y`. Axios appends the
//      `[]` ITSELF for array-valued params, so a key written as `'ids[]'` emits `ids[][]=x` and
//      MangaDex answers 400. This was live-caught: every MangaDex request 400'd on the first run
//      and the layer silently degraded into title matching while still LOOKING like it worked —
//      the bridges still returned ids, just via the weaker path. A regression here is invisible
//      without this test.
//
//   3. A BRIDGE THAT CANNOT NAME A PROVIDER'S ID SPACE MUST COST NOTHING. Both bridges are
//      registered by default now, so an uncovered provider (MangaPill) or a duck-typed fake must
//      return null WITHOUT issuing an upstream request. If that invariant breaks, every offline
//      suite in the repo starts making network calls.
//
//   4. THE HONEST LABEL SURVIVES. MangaPill has no MAL-Sync coverage, so it is title-matched and
//      must stay 'unverified' in the same response where MangaDex and MangaHere are 'exact-id'.
//      Live, MangaPill's best title match for Solo Leveling is "Solo Leveling Novel" — the light
//      novel, a genuinely wrong series — which is exactly what the label is for.
//
//   5. A BROKEN BRIDGE CAN NEVER MANUFACTURE CONFIDENCE. A throwing bridge is swallowed and the
//      call falls through to title matching.
//
// Offline: every HTTP call is served by a fake axios adapter installed on the aggregator's own
// public `client`, which the metadata layer shares by construction. Fixtures are real responses
// captured 2026-08-14 from graphql.anilist.co, api.malsync.moe and api.mangadex.org.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const axios = require('axios');
const aggMod = require('../dist/providers/meta/manga-aggregator.js');
const metaMod = require('../dist/providers/meta/manga-metadata.js');
const xrefMod = require('../dist/providers/meta/manga-xref.js');

const MangaAggregator = aggMod.default ?? aggMod;
const { AniListMangaMetadataResolver } = aggMod;
const { createMangaMetadataLayer, MalSyncBridge, MangaDexLinksBridge } = metaMod;
const { MalSyncIndex, MangaDexXref, MALSYNC_SITE_BINDINGS, pickSiteEntry } = xrefMod;

// =============================================================================================
// FIXTURES — real captured responses, trimmed to the fields the layer reads.
// =============================================================================================

/** AniList `Media(id: 105398, type: MANGA)`. Note the id space: this is a MANGA id. */
const ANILIST_SOLO = {
  data: {
    Media: {
      id: 105398,
      idMal: 121496,
      title: { romaji: 'Na Honjaman Level Up', english: 'Solo Leveling', native: '나 혼자만 레벨업' },
      synonyms: ['I Level Up Alone', 'Only I Level Up'],
      format: 'MANGA',
      status: 'FINISHED',
      chapters: 201,
      volumes: 15,
      countryOfOrigin: 'KR',
      startDate: { year: 2018 },
    },
  },
};

/** AniList One Piece — the RELEASING case, where `chapters`/`volumes` are BOTH null. */
const ANILIST_ONE_PIECE = {
  data: {
    Media: {
      id: 30013,
      idMal: 13,
      title: { romaji: 'ONE PIECE', english: 'One Piece', native: 'ONE PIECE' },
      synonyms: ['ワンピース'],
      format: 'MANGA',
      status: 'RELEASING',
      chapters: null,
      volumes: null,
      countryOfOrigin: 'JP',
      startDate: { year: 1997 },
    },
  },
};

/** `GET api.malsync.moe/mal/manga/121496`. Two Mangadex records, two MangaNato records. */
const MALSYNC_SOLO = {
  id: 121496,
  title: 'Solo Leveling',
  type: 'manga',
  Sites: {
    Mangadex: {
      '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0': {
        identifier: '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0',
        title: 'Na Honjaman Level-Up',
        aniId: 105398,
        malId: 121496,
        page: 'Mangadex',
        type: 'manga',
        url: 'https://mangadex.org/title/32d76d19-8a05-4db0-9fc2-e0b0648fe9d0',
      },
      'd6c1f26b-095a-411e-ae8f-faca5c39538a': {
        identifier: 'd6c1f26b-095a-411e-ae8f-faca5c39538a',
        title: 'Solo Leveling (Book Version)',
        aniId: 105398,
        malId: 121496,
        page: 'Mangadex',
        type: 'manga',
        url: 'https://mangadex.org/title/d6c1f26b-095a-411e-ae8f-faca5c39538a',
      },
    },
    MangaFox: {
      solo_leveling: {
        identifier: 'solo_leveling',
        title: 'Solo Leveling',
        aniId: 105398,
        malId: 121496,
        page: 'MangaFox',
        type: 'manga',
        url: 'https://fanfox.net/manga/solo_leveling/',
      },
    },
    MangaNato: {
      'solo-leveling': {
        identifier: 'solo-leveling',
        title: 'Solo Leveling',
        aniId: 105398,
        malId: 121496,
        page: 'MangaNato',
        type: 'manga',
        url: 'https://www.manganato.gg/manga/solo-leveling',
      },
      'solo-leveling-comic': {
        identifier: 'solo-leveling-comic',
        title: 'Solo Leveling (Comic)',
        aniId: 105398,
        malId: 121496,
        page: 'MangaNato',
        type: 'manga',
        url: 'https://www.manganato.gg/manga/solo-leveling-comic',
      },
    },
    // `external: true` official readers, whose `identifier` is a positional index, not an id.
    VIZ: { 0: { identifier: 0, title: 'Solo Leveling', page: 'VIZ', external: true, url: 'https://www.viz.com/x' } },
  },
};

/**
 * `GET api.mangadex.org/manga?ids[]=…`. THE ADVERSARIAL PAIR:
 *   * the canonical record's primary title is `ko-ro` and looks nothing like "Solo Leveling",
 *     and it is the one carrying `links.al: '105398'`;
 *   * the decoy is titled exactly "Solo Leveling (Book Version)" and carries NO links.
 */
const MANGADEX_SOLO_BATCH = {
  result: 'ok',
  data: [
    {
      id: '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0',
      attributes: {
        title: { 'ko-ro': 'Na Honjaman Level-Up' },
        altTitles: [
          { ko: '나 혼자만 레벨업' },
          { en: 'Solo Leveling' },
          { 'ko-ro': 'Na Honjaman Lebel-eob' },
          { en: 'I level up alone' },
        ],
        links: { al: '105398', mal: '121496' },
        year: 2018,
        originalLanguage: 'ko',
        status: 'completed',
      },
    },
    {
      id: 'd6c1f26b-095a-411e-ae8f-faca5c39538a',
      attributes: {
        title: { en: 'Solo Leveling (Book Version)' },
        altTitles: [{ en: 'Solo Leveling (Comic)' }, { ko: '만화 나 혼자만 레벨업' }],
        links: {},
        year: null,
        originalLanguage: 'ko',
        status: 'completed',
      },
    },
  ],
};

/**
 * `GET api.mangadex.org/manga?title=Solo Leveling`. MangaDex's OWN relevance ranking puts the
 * SEQUEL first (`links.al: '179445'`). Only the id comparison reaches the right record.
 */
const MANGADEX_SOLO_TITLE_SEARCH = {
  result: 'ok',
  data: [
    {
      id: 'ade0306c-f4b6-4890-9edb-1ddf04df2039',
      attributes: {
        title: { 'ko-ro': 'Na Honjaman Level Up: Ragnarok' },
        altTitles: [{ en: 'Solo Leveling: Ragnarok' }],
        links: { al: '179445' },
        year: 2024,
      },
    },
    MANGADEX_SOLO_BATCH.data[0],
    {
      id: '685383ff-58e1-4739-873e-dfddaa87a7dd',
      attributes: {
        title: { en: 'Solo Leveling - The revenge of sung jin-woo (Doujinshi)' },
        altTitles: [],
        links: {},
      },
    },
  ],
};

/** One Piece: only the base record carries `links.al`; both colour re-releases carry none. */
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
    {
      id: 'a2c1d849-af05-4bbc-b2a7-866ebb10331f',
      attributes: { title: { en: 'One Piece (Official Colored)' }, altTitles: [], links: {} },
    },
    {
      id: 'c2e76d62-702b-4a8e-a4d0-c7cecd45b8ea',
      attributes: { title: { en: 'One Piece (Fan Colored)' }, altTitles: [], links: {} },
    },
  ],
};

const MALSYNC_ONE_PIECE = {
  id: 13,
  title: 'One Piece',
  Sites: {
    Mangadex: Object.fromEntries(
      ['a1c7c817-4e59-43b7-9365-09675a149a6f', 'a2c1d849-af05-4bbc-b2a7-866ebb10331f', 'c2e76d62-702b-4a8e-a4d0-c7cecd45b8ea'].map(
        (id, i) => [
          id,
          {
            identifier: id,
            title: ['One Piece', 'One Piece (Official Colored)', 'One Piece (Fan Colored)'][i],
            aniId: 30013,
            malId: 13,
            page: 'Mangadex',
          },
        ]
      )
    ),
    MangaFox: {
      one_piece: { identifier: 'one_piece', title: 'One Piece', aniId: 30013, malId: 13, page: 'MangaFox' },
    },
    // Live, MangaNato lists FOUR One Piece records and the colour editions come FIRST.
    MangaNato: Object.fromEntries(
      [
        ['one-piece-digital-colored-comics', 'One Piece - Digital Colored Comics'],
        ['one-piece', 'One Piece'],
        ['one-piece-colored', 'One Piece (Colored)'],
      ].map(([identifier, title]) => [identifier, { identifier, title, aniId: 30013, malId: 13, page: 'MangaNato' }])
    ),
  },
};

// =============================================================================================
// TEST HARNESS
// =============================================================================================

/**
 * axios adapter over a {url-substring → body} map, matching on the FULLY SERIALISED uri so that
 * tests can route on (and assert) the real query string axios produces. Anything unmatched
 * rejects, the way a dead host does. `seen` records every request.
 */
const fakeAdapter = routes => {
  const seen = [];
  const adapter = async config => {
    // getUri applies the instance's real param serialiser — which is the whole point of test #2.
    const url = axios.getUri(config);
    seen.push(url);
    const hit = Object.keys(routes)
      .filter(k => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (hit === undefined) throw new Error(`ECONNREFUSED ${url}`);
    const entry = routes[hit];
    const { status = 200, data } = typeof entry === 'object' && entry !== null && 'status' in entry ? entry : { data: entry };
    return { data, status, statusText: 'OK', headers: {}, config };
  };
  adapter.seen = seen;
  return adapter;
};

/**
 * Merge overrides into a route table so that an override SHADOWS every more-specific base route
 * beneath it.
 *
 * WHY THIS IS NOT A PLAIN SPREAD. `fakeAdapter` resolves by LONGEST matching substring, so a plain
 * `{...base, 'api.mangadex.org': {status: 503}}` leaves the longer `'api.mangadex.org/manga?ids'`
 * entry still winning and the override does nothing at all. Two tests in this file passed for
 * exactly that wrong reason before this helper existed — the "MangaDex is down" case was quietly
 * being served a healthy MangaDex.
 */
const withRoutes = (base, overrides) => {
  const merged = { ...base };
  for (const key of Object.keys(overrides))
    for (const existing of Object.keys(merged)) if (existing.startsWith(key)) delete merged[existing];
  return { ...merged, ...overrides };
};

/** The Solo Leveling world: AniList + MAL-Sync + both MangaDex shapes. */
const soloRoutes = (overrides = {}) =>
  withRoutes(
    {
      'graphql.anilist.co': ANILIST_SOLO,
      'api.malsync.moe/mal/manga/121496': MALSYNC_SOLO,
      'api.mangadex.org/manga?ids': MANGADEX_SOLO_BATCH,
      'api.mangadex.org/manga?title': MANGADEX_SOLO_TITLE_SEARCH,
    },
    overrides
  );

const onePieceRoutes = () => ({
  'graphql.anilist.co': ANILIST_ONE_PIECE,
  'api.malsync.moe/mal/manga/13': MALSYNC_ONE_PIECE,
  'api.mangadex.org/manga?ids': MANGADEX_ONE_PIECE_BATCH,
});

/** Build the metadata layer standalone over a fake-adapter client. */
const layerOn = routes => {
  const adapter = fakeAdapter(routes);
  const client = axios.create({ adapter });
  return { ...createMangaMetadataLayer(client, new AniListMangaMetadataResolver(client)), adapter, client };
};

/** Swallow diagnostic logs and hand them back. */
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

/** A duck-typed MangaParser. The registry must accept these or only the real three are testable. */
const fake = (name, results = []) => ({
  parser: {
    name,
    calls: [],
    async search(q, page, limit) {
      this.calls.push(`search:${q}`);
      return { results };
    },
    async fetchMangaInfo(id) {
      this.calls.push(`info:${id}`);
      return { id, title: name, chapters: [{ id: `${id}-ch1`, title: 'Chapter 1' }] };
    },
    async fetchChapterPages(id) {
      return [];
    },
  },
});

/** An aggregator wired to the DEFAULT metadata layer, with its shared client faked out. */
const aggregatorOn = (routes, providers) => {
  const adapter = fakeAdapter(routes);
  const agg = new MangaAggregator({ providers });
  agg.client.defaults.adapter = adapter;
  return { agg, adapter };
};

// =============================================================================================

describe('MangaDex links.al is an id equality, not a title match', () => {
  test('it finds the record whose primary title is a Korean romanisation, over a decoy titled "Solo Leveling"', async () => {
    // This is the whole thesis. Title similarity against "Solo Leveling" ranks
    // "Solo Leveling (Book Version)" first and cannot reach "Na Honjaman Level-Up" at all.
    const { xref } = layerOn(soloRoutes());
    const { out: record } = await capture(() =>
      xref.resolve({ anilistId: '105398', titles: ['Solo Leveling'], malId: 121496 })
    );
    assert.equal(record.id, '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0');
    assert.equal(record.links.al, '105398', 'the match must be links.al equality');
    assert.equal(record.matchedBy, 'malsync-then-links.al');
    assert.notEqual(record.id, 'd6c1f26b-095a-411e-ae8f-faca5c39538a', 'the decoy has the better TITLE and no links');
  });

  test('array params are serialised as ids[]=, NOT ids[][]= — axios appends the brackets itself', async () => {
    // Live-caught regression: `params: { 'ids[]': [...] }` emits `ids[][]=` and MangaDex 400s the
    // whole request, silently demoting the strongest bridge to the title-matching fallback.
    const { xref, adapter } = layerOn(soloRoutes());
    await capture(() => xref.resolve({ anilistId: '105398', titles: ['Solo Leveling'], malId: 121496 }));
    const mdx = adapter.seen.find(u => u.includes('api.mangadex.org/manga?ids'));
    assert.ok(mdx, `no MangaDex ids[] request was issued: ${JSON.stringify(adapter.seen)}`);
    assert.ok(!mdx.includes('ids[][]='), `double-bracketed array param — MangaDex answers 400: ${mdx}`);
    assert.ok(mdx.includes('ids[]='), `expected ids[]= : ${mdx}`);
    assert.ok(!mdx.includes('contentRating[][]='), `double-bracketed contentRating: ${mdx}`);
    assert.ok(mdx.includes('contentRating[]=safe'), `expected contentRating[]=safe : ${mdx}`);
  });

  test('only the base One Piece record carries links.al — the colour re-releases are rejected on data, not heuristics', async () => {
    const { xref } = layerOn(onePieceRoutes());
    const { out: record } = await capture(() =>
      xref.resolve({ anilistId: '30013', titles: ['One Piece'], malId: 13 })
    );
    assert.equal(record.id, 'a1c7c817-4e59-43b7-9365-09675a149a6f');
    assert.equal(record.links.al, '30013');
  });

  test('falls back to title search when the ids[] batch has no links.al hit, and still matches by id', async () => {
    // MangaDex's own relevance puts the SEQUEL (al=179445) first in the title search; links.al
    // still selects 105398.
    const { xref, adapter } = layerOn(
      soloRoutes({ 'api.mangadex.org/manga?ids': { result: 'ok', data: [MANGADEX_SOLO_BATCH.data[1]] } })
    );
    const { out: record } = await capture(() =>
      xref.resolve({ anilistId: '105398', titles: ['Solo Leveling'], malId: 121496 })
    );
    assert.equal(record.id, '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0');
    assert.equal(record.matchedBy, 'title-search-then-links.al');
    assert.ok(adapter.seen.some(u => u.includes('manga?title')));
  });

  test('a MangaDex outage yields null, never a throw — title matching must still run', async () => {
    const { xref } = layerOn(soloRoutes({ 'api.mangadex.org/manga': { status: 503, data: 'nope' } }));
    const { out: record, logs } = await capture(() =>
      xref.resolve({ anilistId: '105398', titles: ['Solo Leveling'], malId: 121496 })
    );
    assert.equal(record, null);
    assert.ok(logs.some(l => l.includes('503')), `the outage must be logged: ${JSON.stringify(logs)}`);
  });
});

describe('MAL-Sync id bridge', () => {
  test('a hit produces the provider id with zero provider search — MangaFox identifier IS the MangaHere slug', async () => {
    // VERIFIED LIVE 2026-08-14: mangahere.cc/manga/one_piece/ → 200 "One Piece … at MangaHere",
    // mangahere.cc/manga/zzz_not_a_real_series_xyzzy/ → 302. The slug spaces are shared.
    const { bridges } = layerOn(soloRoutes());
    const malsync = bridges.find(b => b.via === 'malsync');
    const { out: id } = await capture(() =>
      malsync.lookup({ anilistId: '105398', titles: ['Solo Leveling'], malId: 121496 }, 'MangaHere')
    );
    assert.equal(id, 'solo_leveling');
  });

  test('MangaNato identifier IS the MangaKakalot slug, and re-releases lose the tiebreak', async () => {
    // VERIFIED LIVE: manganato.gg/manga/chainsaw-man → 200, /manga/zzz-not-a-real-series-xyzzy → 404.
    // MangaKakalot's own baseUrl is manganato.gg, so this is structural, not coincidental.
    const { bridges } = layerOn(onePieceRoutes());
    const malsync = bridges.find(b => b.via === 'malsync');
    const { out: id, logs } = await capture(() =>
      malsync.lookup({ anilistId: '30013', titles: ['One Piece'], malId: 13 }, 'MangaKakalot')
    );
    assert.equal(id, 'one-piece', 'the colour editions are listed FIRST upstream and must not win');
    assert.ok(
      logs.some(l => l.includes('title-assisted')),
      'a multi-record tiebreak is title-assisted and must say so rather than claim a pure id match'
    );
  });

  test('an aniId that disagrees with the requested AniList id rejects the entry outright', async () => {
    const entries = [
      { identifier: 'wrong-series', title: 'Solo Leveling', aniId: 999999 },
      { identifier: 'right-series', title: 'Na Honjaman Level-Up', aniId: 105398 },
    ];
    const picked = pickSiteEntry(entries, { anilistId: '105398', titles: ['Solo Leveling'] }, 'MangaNato');
    assert.equal(picked.identifier, 'right-series', 'aniId is a filter, not a tiebreak — title must not rescue');
  });

  test('MAL-Sync 404 is a clean miss, not an error', async () => {
    // Verified live: an unknown MAL id returns 404 rather than 200-with-empty-Sites.
    const index = new MalSyncIndex(axios.create({ adapter: fakeAdapter({ 'api.malsync.moe': { status: 404, data: '' } }) }));
    assert.equal(await index.lookup(99999999), null);
  });

  test('an uncovered provider costs ZERO upstream requests — this is what makes default registration safe', async () => {
    const { bridges, adapter } = layerOn(soloRoutes());
    const meta = { anilistId: '105398', titles: ['Solo Leveling'], malId: 121496 };
    for (const name of ['MangaPill', 'MangaPark', 'VyvyManga', 'AsuraScans', 'Alpha']) {
      for (const b of bridges) assert.equal(await b.lookup(meta, name), null, `${b.via} answered for ${name}`);
    }
    assert.deepEqual(adapter.seen, [], `uncovered providers must not touch the network: ${JSON.stringify(adapter.seen)}`);
  });

  test('no malId means no request — MAL-Sync has no AniList-keyed manga endpoint', async () => {
    // Verified live: api.malsync.moe/anilist/manga/105778 → 404. This limit is structural.
    const { bridges, adapter } = layerOn(soloRoutes());
    const malsync = bridges.find(b => b.via === 'malsync');
    assert.equal(await malsync.lookup({ anilistId: '105398', titles: ['Solo Leveling'] }, 'MangaHere'), null);
    assert.deepEqual(adapter.seen, []);
  });

  test('every shipped site binding names a provider and records its provenance', () => {
    for (const b of MALSYNC_SITE_BINDINGS) {
      assert.ok(b.site && b.provider && typeof b.toProviderId === 'function', `incomplete binding: ${b.site}`);
      assert.ok(
        /VERIFIED LIVE|INFERENCE/.test(b.provenance),
        `${b.site} must state whether it was probed or inferred — an unlabelled binding is folklore`
      );
    }
  });
});

describe('the aggregator, wired to the default metadata layer', () => {
  test('one call yields MangaDex exact-id, MangaHere exact-id via malsync, and MangaPill honestly unverified', async () => {
    // The headline. Note MangaPill has NO MAL-Sync coverage, so it is title-matched — live, its
    // best hit for this series is "Solo Leveling Novel", the light novel. The label is the defence.
    const providers = [
      fake('MangaDex'),
      fake('MangaHere'),
      fake('MangaPill', [{ id: '8136/solo-leveling-novel', title: 'Solo Leveling Novel' }]),
    ];
    const { agg } = aggregatorOn(soloRoutes(), providers);
    const { out } = await capture(() => agg.getMappings(105398));

    const by = Object.fromEntries(out.map(m => [m.provider, m]));
    assert.equal(by.MangaDex.id, '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0');
    assert.equal(by.MangaDex.matchConfidence, 'exact-id');
    assert.equal(by.MangaDex.via, 'mangadex-links.al', 'the verified bridge must outrank malsync');

    assert.equal(by.MangaHere.id, 'solo_leveling');
    assert.equal(by.MangaHere.matchConfidence, 'exact-id');
    assert.equal(by.MangaHere.via, 'malsync');

    assert.equal(by.MangaPill.matchConfidence, 'unverified');
    assert.equal(by.MangaPill.via, undefined);

    // A bridge hit skips the provider search entirely; an uncovered provider still searches.
    assert.deepEqual(providers[0].parser.calls, [], 'MangaDex was bridged — no search should be issued');
    assert.deepEqual(providers[1].parser.calls, [], 'MangaHere was bridged — no search should be issued');
    assert.ok(providers[2].parser.calls.length > 0, 'MangaPill has no bridge and MUST fall through to search');
  });

  test('the whole fan-out costs one MAL-Sync GET and one MangaDex GET, not one per provider per bridge', async () => {
    // Three providers x two bridges + the resolver = up to 8 identical lookups, all issued
    // concurrently before any plain value cache could fill. TtlCache's in-flight map is what
    // collapses them.
    const { agg, adapter } = aggregatorOn(soloRoutes(), [fake('MangaDex'), fake('MangaHere'), fake('MangaPill')]);
    await capture(() => agg.getMappings(105398));
    const count = p => adapter.seen.filter(u => u.includes(p)).length;
    assert.equal(count('api.malsync.moe'), 1, `MAL-Sync fan-out not deduplicated: ${JSON.stringify(adapter.seen)}`);
    assert.equal(count('api.mangadex.org'), 1, `MangaDex fan-out not deduplicated: ${JSON.stringify(adapter.seen)}`);
    assert.equal(count('graphql.anilist.co'), 1);
  });

  test('a bridge miss falls through to title matching without throwing', async () => {
    // MAL-Sync knows nothing about this series (404), so nothing is bridged and every provider is
    // title-matched — served, but labelled.
    const providers = [fake('MangaHere', [{ id: 'solo_leveling', title: 'Solo Leveling' }])];
    const { agg } = aggregatorOn(
      soloRoutes({ 'api.malsync.moe': { status: 404, data: '' }, 'api.mangadex.org': { status: 404, data: '' } }),
      providers
    );
    const { out } = await capture(() => agg.getMappings(105398));
    assert.equal(out.length, 1);
    assert.equal(out[0].matchConfidence, 'unverified');
    assert.equal(out[0].id, 'solo_leveling');
    assert.ok(providers[0].parser.calls.length > 0, 'the search must actually run');
  });

  test('a THROWING bridge is swallowed and can never manufacture confidence', async () => {
    // Deliberate B1 behaviour: a bridge bug must degrade to the honest label, not take down the
    // call and not fabricate an exact-id.
    const providers = [fake('MangaHere', [{ id: 'solo_leveling', title: 'Solo Leveling' }])];
    const agg = new MangaAggregator({
      providers,
      metadata: { resolve: async () => ({ anilistId: '105398', titles: ['Solo Leveling'], malId: 121496 }) },
      bridges: [
        {
          name: 'boom',
          via: 'malsync',
          lookup: async () => {
            throw new Error('bridge down');
          },
        },
      ],
    });
    const { out, logs } = await capture(() => agg.getMappings(105398));
    assert.equal(out.length, 1);
    assert.equal(out[0].matchConfidence, 'unverified');
    assert.ok(logs.some(l => l.includes('id bridge boom failed')));
  });

  test('AniList stays the canonical id space: One Piece manga 30013 resolves with chapters AND volumes null', async () => {
    // The honest constraint. AniList reports null/null for every RELEASING series, so the
    // chapter-count backstop is absent exactly where wrong-match risk is highest. Nothing here
    // invents a replacement — no EPISODE_COUNT_TOLERANCE analogue exists.
    const { metadata } = layerOn(onePieceRoutes());
    const { out: meta } = await capture(() => metadata.resolve(30013));
    assert.equal(meta.anilistId, '30013');
    assert.equal(meta.chapters, undefined, 'RELEASING series report chapters: null');
    assert.equal(meta.volumes, undefined);
    assert.equal(meta.malId, 13);
    assert.equal(meta.countryOfOrigin, 'JP');
    assert.equal(meta.startYear, 1997);
    assert.equal(meta.format, 'MANGA');
  });
});

describe('metadata enrichment fills holes and never overwrites AniList', () => {
  test('MangaDex alt titles are APPENDED — titles[0] stays AniList’s primary', async () => {
    // rankedMatches searches providers with meta.titles[0]. Reordering would silently change what
    // every provider is asked for.
    const { metadata } = layerOn(soloRoutes());
    const { out: meta } = await capture(() => metadata.resolve(105398));
    assert.equal(meta.titles[0], 'Solo Leveling', 'AniList primary must stay at index 0');
    assert.ok(meta.titles.includes('Na Honjaman Lebel-eob'), 'a romanisation only MangaDex knows must be added');
    assert.ok(meta.titles.length > ANILIST_SOLO.data.Media.synonyms.length + 3);
    assert.ok(meta.titles.length <= 24, 'the title list must stay bounded — rankedMatches is O(n*m) per result');
  });

  test('idMal is backfilled from links.mal when AniList has none — this is what unlocks the MAL-Sync bridge', async () => {
    const noMal = JSON.parse(JSON.stringify(ANILIST_SOLO));
    noMal.data.Media.idMal = null;
    // With no idMal there is no MAL-Sync key, so MangaDex must be reached by the title fallback.
    const { metadata } = layerOn(soloRoutes({ 'graphql.anilist.co': noMal }));
    const { out: meta, logs } = await capture(() => metadata.resolve(105398));
    assert.equal(meta.malId, 121496);
    assert.ok(logs.some(l => l.includes('adopting') && l.includes('121496')));
  });

  test('a MAL id conflict keeps AniList’s and LOGS the disagreement rather than reconciling silently', async () => {
    const conflicting = JSON.parse(JSON.stringify(MANGADEX_SOLO_BATCH));
    conflicting.data[0].attributes.links.mal = '999999';
    const { metadata } = layerOn(soloRoutes({ 'api.mangadex.org/manga?ids': conflicting }));
    const { out: meta, logs } = await capture(() => metadata.resolve(105398));
    assert.equal(meta.malId, 121496, 'AniList is canonical and wins');
    assert.ok(logs.some(l => l.includes('MAL id CONFLICT')));
  });

  test('an AniList outage short-circuits before spending MangaDex or MAL-Sync requests', async () => {
    // AniList rate limiting is HTTP 200 + populated errors[] + null data. With no titles there is
    // nothing to enrich, and turning one upstream outage into three helps nobody.
    const { metadata, adapter } = layerOn(
      soloRoutes({ 'graphql.anilist.co': { data: null, errors: [{ status: 429, message: 'Too Many Requests' }] } })
    );
    const { out: meta } = await capture(() => metadata.resolve(105398));
    assert.deepEqual(meta.titles, []);
    assert.deepEqual(
      adapter.seen.filter(u => !u.includes('anilist')),
      [],
      'no cross-reference traffic should follow a failed AniList resolve'
    );
  });
});
