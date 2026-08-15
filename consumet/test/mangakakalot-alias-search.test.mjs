// MangaKakalot search: the alias bridge that makes `demon slayer` reach `kimetsu-no-yaiba`.
//
// WHY THIS FILE EXISTS. MangaNato's own search API is real but unreachable — `/home/search/json`
// (the endpoint its own `/js/fsearch.js` calls) and `/search/story/` BOTH answer 403 with
// `cf-mitigated: challenge`, on every UA, with and without `X-Requested-With`, as GET and as POST,
// on all four sibling hosts. The provider therefore ranks queries against a slug index built from
// the sitemap, and a slug encodes exactly ONE title.
//
// THE FAILURE THAT WAS WORSE THAN A MISS. Measured against the live index on 2026-08-14 (93,735
// slugs), `demon slayer` returned NINE confident results and the real series was not among them:
//
//     demon-slayer-tanjiro-kanao-doujinshi, demon-slayer-s-quest,
//     demon-slayer-kimetsu-no-yaiba-colored, demon-slayer-kimetsu-academy, …
//
// That is the silent-degradation shape this repo has been burned by repeatedly: not an empty array
// a caller might notice, but a plausible one it would act on. The fix routes a non-slug query
// through AniList synonyms and MAL-Sync's exact MangaNato identifier, then CONFIRMS the resulting
// slug against this site before returning it.
//
// What each assertion protects:
//   1. THE ACCEPTANCE CASE — `demon slayer` ranks `kimetsu-no-yaiba` first, via the hard-id path.
//      Delete the bridge and this goes red with the doujinshi list above.
//   2. Attested is not the same as stocked. An alias slug the site does not have is never returned.
//   3. The `aniId` cross-check rejects a MAL-Sync entry that maps to a different AniList series.
//   4. AniList titles are an independent second route, for series MAL-Sync has no entry for.
//   5. The bridge costs NOTHING when the query is already an exact slug — no off-site request.
//   6. An AniList HTTP-200-with-errors[] (its rate-limit shape) is an upstream fault, never "no
//      matches" — the exact misreading that turns an outage into a confident wrong answer.
//   7. Empty and degraded answers are LOUD: `diagnostics.warning` is populated and logged.
//   8. Search never requests either challenge-gated search path.
//
// Fully offline: one fake axios adapter serves manganato, AniList and MAL-Sync alike, which works
// because the provider builds its alias bridge from its OWN client.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/manga/mangakakalot.js');
const MangaKakalot = mod.default ?? mod;

const ORIGIN = 'https://www.manganato.gg';
const ANILIST = 'https://graphql.anilist.co';
const MALSYNC = 'https://api.malsync.moe';

// ------------------------------------------------------------------------------------------------
// fixtures — shapes copied from live responses on 2026-08-14
// ------------------------------------------------------------------------------------------------

/** The real AniList ids/popularity for this query. Order is AniList's own SEARCH_MATCH order. */
const ANILIST_DEMON_SLAYER = {
  data: {
    Page: {
      media: [
        // AniList's OWN top hit for "demon slayer" is the wrong series. Its synonym scores 0.769
        // against the query, which clears the 0.7 floor — so it is a real candidate and the only
        // thing that keeps it off the podium is the subtitle-split scoring plus popularity.
        {
          id: 131348,
          idMal: 173492,
          popularity: 571,
          title: { romaji: 'Taima no Haha', english: null, native: '退魔の母' },
          synonyms: ['Demon Slayer Mother'],
        },
        {
          id: 87216,
          idMal: 96792,
          popularity: 208719,
          title: { romaji: 'Kimetsu no Yaiba', english: 'Demon Slayer: Kimetsu no Yaiba', native: '鬼滅の刃' },
          synonyms: ['KnY', 'Guardianes de la Noche'],
        },
        {
          id: 140256,
          idMal: 140256,
          popularity: 2667,
          title: { romaji: 'Kimetsu Gakuen!', english: 'Demon Slayer: Kimetsu Academy', native: null },
          synonyms: [],
        },
      ],
    },
  },
};

/** MAL-Sync names this site's identifier outright. One entry, `aniId` agreeing. */
const MALSYNC_KNY = {
  id: 96792,
  title: 'Kimetsu no Yaiba',
  Sites: {
    MangaNato: {
      'kimetsu-no-yaiba': {
        identifier: 'kimetsu-no-yaiba',
        url: `${ORIGIN}/manga/kimetsu-no-yaiba`,
        title: 'Kimetsu No Yaiba',
        page: 'MangaNato',
        malId: 96792,
        aniId: 87216,
      },
    },
  },
};

const DETAIL_HTML = (slug, title) => `<html><body>
  <div class="manga-info-pic"><img src="https://img-r2.2xstorage.com/thumb/${slug}.webp" alt="${title}" /></div>
  <ul class="manga-info-text">
    <li><h1>${title}</h1></li>
    <li>Status : Ongoing</li>
  </ul>
  <div id="chapter-list-container" data-comic-slug="${slug}"
       data-api-url="${ORIGIN}/api/manga/__SLUG__/chapters"></div>
  <div id="contentBox"><h2><p>${title} summary: </p></h2>A synopsis.</div>
</body></html>`;

const urlset = slugs =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${slugs
    .map(s => `  <url><loc>${ORIGIN}/manga/${s}</loc></url>`)
    .join('\n')}\n</urlset>`;

/**
 * The catalogue, mirroring what the live index really holds for this query: four `demon-slayer-*`
 * distractions, the real series under its romanised slug, and nothing joining the two.
 */
const CATALOGUE = [
  'demon-slayer-tanjiro-kanao-doujinshi',
  'demon-slayer-s-quest',
  'demon-slayer-kimetsu-no-yaiba-colored',
  'demon-slayer-kimetsu-academy',
  'kimetsu-no-yaiba',
  'attack-on-titan',
  'unrelated-series',
];

const baseRoutes = () => ({
  [`${ORIGIN}/sitemap.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex><sitemap><loc>${ORIGIN}/sitemap-comic-1.xml</loc></sitemap></sitemapindex>`,
  [`${ORIGIN}/sitemap-comic-1.xml`]: urlset(CATALOGUE),
  [`${ORIGIN}/manga/kimetsu-no-yaiba`]: DETAIL_HTML('kimetsu-no-yaiba', 'Kimetsu No Yaiba'),
  [`${ORIGIN}/manga/attack-on-titan`]: DETAIL_HTML('attack-on-titan', 'Attack On Titan'),
  [`${ORIGIN}/manga/demon-slayer-kimetsu-academy`]: DETAIL_HTML('demon-slayer-kimetsu-academy', 'Demon Slayer Kimetsu Academy'),
  [ANILIST]: ANILIST_DEMON_SLAYER,
  [`${MALSYNC}/mal/manga/96792`]: MALSYNC_KNY,
  // The other two candidates have no MangaNato mapping — MAL-Sync's real answer for an unknown id.
  [`${MALSYNC}/mal/manga/173492`]: { status: 404 },
  [`${MALSYNC}/mal/manga/140256`]: { status: 404 },
});

// ------------------------------------------------------------------------------------------------
// fake transport
// ------------------------------------------------------------------------------------------------

/**
 * One adapter for all three upstreams. A route may be `{ status }` to force a status, or a body.
 * Unknown `/manga/<slug>` is 404 — the site's real answer, and what the alias bridge's confirmation
 * probe relies on. Anything else rejects, the way an unreachable host behaves.
 */
const fakeAdapter = (routes = baseRoutes(), { fail = () => false } = {}) => {
  const seen = [];
  const adapter = async config => {
    const url = String(config.url);
    seen.push(url);
    if (fail(url)) throw new Error(`blocked by test: ${url}`);
    if (Object.prototype.hasOwnProperty.call(routes, url)) {
      const route = routes[url];
      const status = route && typeof route === 'object' && typeof route.status === 'number' ? route.status : 200;
      const data = status === 200 ? route : '';
      return { data, status, statusText: '', headers: {}, config };
    }
    if (url.startsWith(`${ORIGIN}/manga/`)) return { data: '404', status: 404, statusText: '', headers: {}, config };
    throw new Error(`ECONNREFUSED ${url}`);
  };
  adapter.seen = seen;
  return adapter;
};

const provider = adapter => {
  const p = new MangaKakalot();
  p.client.defaults.adapter = adapter;
  return p;
};

const offSite = seen => seen.filter(u => !u.startsWith(ORIGIN));

// Every test asserts on diagnostics, and the provider logs each warning. Keep the output readable
// while still proving the log happened.
let warnings;
let errors;
let realWarn;
let realError;
beforeEach(() => {
  warnings = [];
  errors = [];
  realWarn = console.warn;
  realError = console.error;
  console.warn = msg => warnings.push(String(msg));
  console.error = msg => errors.push(String(msg));
});
afterEach(() => {
  console.warn = realWarn;
  console.error = realError;
});

// ------------------------------------------------------------------------------------------------

describe('the acceptance case: an English title reaches a romanised slug', () => {
  test('"demon slayer" ranks kimetsu-no-yaiba FIRST, via MAL-Sync\'s hard id', async () => {
    // Before the alias bridge this query returned the four `demon-slayer-*` distractions below and
    // never mentioned the real series. Reverting the bridge puts this back to red.
    const res = await provider(fakeAdapter()).search('demon slayer');

    assert.equal(res.results[0].id, 'kimetsu-no-yaiba', `top hit was ${res.results[0].id}`);
    assert.equal(res.results[0].matchedVia, 'alias-malsync', 'the hard-id path did not produce it');
    // Enriched from the real detail page, so not a de-slugified guess.
    assert.equal(res.results[0].title, 'Kimetsu No Yaiba');
    assert.ok(!res.results[0].approximateTitle, 'the enriched top hit must not be flagged approximate');
    assert.equal(res.diagnostics.aliasBridgeRan, true);
    assert.ok(res.diagnostics.strategy.includes('alias-malsync'), `strategy: ${res.diagnostics.strategy}`);
  });

  test('the slug-substring hits are kept, but ranked BELOW the real series', async () => {
    // The distractions are legitimate results; the bug was their RANK, not their presence. Dropping
    // them would be a different kind of lying.
    const res = await provider(fakeAdapter()).search('demon slayer');
    const ids = res.results.map(r => r.id);

    assert.ok(ids.includes('demon-slayer-tanjiro-kanao-doujinshi'), `lost a slug hit: ${ids.join(', ')}`);
    assert.ok(
      ids.indexOf('kimetsu-no-yaiba') < ids.indexOf('demon-slayer-tanjiro-kanao-doujinshi'),
      `the doujinshi outranked the real series: ${ids.join(', ')}`
    );
    assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
    for (const r of res.results) assert.ok(r.matchedVia, `result without provenance: ${JSON.stringify(r)}`);
  });

  test('every result says how it was reached', async () => {
    const res = await provider(fakeAdapter()).search('demon slayer');
    const allowed = new Set(['slug-index', 'alias-malsync', 'alias-anilist-title', 'slug-probe', 'browse-listing']);
    for (const r of res.results) assert.ok(allowed.has(r.matchedVia), `unknown matchedVia: ${r.matchedVia}`);
  });
});

describe('an alias is attested, then CONFIRMED against this site', () => {
  test('a series this site does not stock is never returned, however well attested', async () => {
    // "Taima no Haha" is a real AniList series and a real candidate for this query (its synonym
    // "Demon Slayer Mother" scores 0.769). The site has no such slug, so it must not appear —
    // AniList knowing a series exists says nothing about MangaNato carrying it.
    const res = await provider(fakeAdapter()).search('demon slayer');
    const ids = res.results.map(r => r.id);
    for (const bad of ['taima-no-haha', 'demon-slayer-mother', 'kny'])
      assert.ok(!ids.includes(bad), `an unconfirmed alias slug was returned: ${bad}`);
  });

  test('a MAL-Sync entry whose aniId names a DIFFERENT series is rejected', async () => {
    // Same payload, one field changed: MAL-Sync now claims this MangaNato record is AniList 999999.
    // The identifier still points at a slug that exists here, so nothing but the id check can catch
    // it — if that check is dropped, this returns a confidently wrong hard-id match.
    const routes = baseRoutes();
    routes[`${MALSYNC}/mal/manga/96792`] = {
      ...MALSYNC_KNY,
      Sites: { MangaNato: { x: { ...MALSYNC_KNY.Sites.MangaNato['kimetsu-no-yaiba'], aniId: 999999 } } },
    };
    const res = await provider(fakeAdapter(routes)).search('demon slayer');

    const top = res.results[0];
    assert.notEqual(top.matchedVia, 'alias-malsync', 'a mismatched aniId was accepted as a hard id');
  });

  test('the confirmation probe is bounded, so an alias miss cannot fan out', async () => {
    const adapter = fakeAdapter();
    await provider(adapter).search('demon slayer');
    // At most ALIAS_PROBE_BUDGET (2) speculative /manga/<slug> confirmations for slugs the sitemap
    // does not list, plus the single top-hit enrichment fetch.
    const detailFetches = adapter.seen.filter(u => /^https:\/\/www\.manganato\.gg\/manga\/[^/]+$/.test(u));
    assert.ok(detailFetches.length <= 3, `unbounded probing: ${detailFetches.join(', ')}`);
  });
});

describe('AniList titles are an independent second route', () => {
  test('a candidate with no MAL-Sync mapping still resolves through a slugified title', async () => {
    // MAL-Sync 404s for idMal 140256, so "Demon Slayer: Kimetsu Academy" can only be reached by
    // slugifying an AniList title onto `demon-slayer-kimetsu-academy`.
    const res = await provider(fakeAdapter()).search('demon slayer');
    const academy = res.results.find(r => r.id === 'demon-slayer-kimetsu-academy');

    assert.ok(academy, `missing: ${res.results.map(r => r.id).join(', ')}`);
    assert.equal(academy.matchedVia, 'alias-anilist-title', 'the title route did not claim it');
  });

  test('the whole bridge still works when MAL-Sync is down entirely', async () => {
    // MAL-Sync rate-limits (a live 429 was observed mid-verification). A degraded strong path must
    // not take the weak one down with it.
    const res = await provider(fakeAdapter(baseRoutes(), { fail: u => u.startsWith(MALSYNC) })).search('demon slayer');
    const ids = res.results.map(r => r.id);
    assert.ok(ids.includes('kimetsu-no-yaiba'), `MAL-Sync being down lost the series: ${ids.join(', ')}`);
    assert.equal(res.results.find(r => r.id === 'kimetsu-no-yaiba').matchedVia, 'alias-anilist-title');
  });
});

describe('the bridge is free when it is not needed', () => {
  test('a query that IS a slug makes no off-site request at all', async () => {
    const adapter = fakeAdapter();
    const res = await provider(adapter).search('attack on titan');

    assert.equal(res.results[0].id, 'attack-on-titan');
    assert.equal(res.diagnostics.aliasBridgeRan, false, 'the bridge ran for an exact slug hit');
    assert.deepEqual(offSite(adapter.seen), [], `off-site requests for an exact slug: ${offSite(adapter.seen)}`);
  });

  test('useAliasResolution = false disables every off-site request', async () => {
    const adapter = fakeAdapter();
    const p = provider(adapter);
    p.useAliasResolution = false;
    const res = await p.search('demon slayer');

    assert.deepEqual(offSite(adapter.seen), [], `bridge disabled but still called out: ${offSite(adapter.seen)}`);
    assert.equal(res.diagnostics.aliasBridgeRan, false);
    assert.ok(!res.results.some(r => r.id === 'kimetsu-no-yaiba'), 'bridge disabled yet an alias hit appeared');
    // ...and the caller is told the answer is the degraded one.
    assert.match(res.diagnostics.warning, /alias bridge/i, `no warning: ${res.diagnostics.warning}`);
  });

  test('search never touches either challenge-gated search path', async () => {
    const adapter = fakeAdapter();
    await provider(adapter).search('demon slayer');
    for (const url of adapter.seen) {
      assert.doesNotMatch(url, /\/search\/story\//, `hit the robots-disallowed endpoint: ${url}`);
      assert.doesNotMatch(url, /\/home\/search\/json/, `hit the challenge-gated AJAX endpoint: ${url}`);
    }
  });
});

describe('failure is loud, never an empty array on its own', () => {
  test('AniList 200-with-errors is an upstream fault, NOT "no matches"', async () => {
    // AniList signals rate limiting as HTTP 200 with a populated errors[] and null data. Reading it
    // as absence is how an outage becomes a confident wrong answer.
    const routes = baseRoutes();
    routes[ANILIST] = { data: null, errors: [{ message: 'Too Many Requests', status: 429 }] };
    const res = await provider(fakeAdapter(routes)).search('demon slayer');

    assert.ok(
      errors.some(e => /AniList alias search/i.test(e) && /NOT as "no matches"/i.test(e)),
      `the fault was not logged as a fault: ${errors.join(' | ')}`
    );
    assert.ok(!res.results.some(r => r.id === 'kimetsu-no-yaiba'));
    assert.match(res.diagnostics.warning, /no alternative title was confirmed/i);
    assert.match(res.diagnostics.warning, /the alias bridge ran/i, 'must distinguish "ran and failed" from "disabled"');
  });

  test('a genuine miss reports WHAT was tried, not just nothing', async () => {
    const res = await provider(fakeAdapter()).search('zzzz no such series xyzzy');

    assert.deepEqual(res.results, []);
    assert.equal(res.totalResults, 0);
    const w = res.diagnostics.warning;
    assert.match(w, /NO results/i, `unhelpful warning: ${w}`);
    assert.match(w, /7 slugs/, `the warning must state the corpus size it searched: ${w}`);
    assert.match(w, /alias bridge ran/i, `the warning must state whether the bridge ran: ${w}`);
    assert.ok(warnings.some(m => /NO results/i.test(m)), 'the miss was not logged');
  });

  test('"the sitemap was down" is distinguishable from "the series is absent"', async () => {
    // Both used to look identical to a caller: an empty array. They demand opposite responses —
    // retry vs. give up — so they must not be conflated.
    const res = await provider(fakeAdapter(baseRoutes(), { fail: u => u.includes('sitemap') })).search(
      'zzzz no such series xyzzy'
    );

    assert.equal(res.diagnostics.indexedSlugs, 0);
    assert.match(
      res.diagnostics.warning,
      /could not be built|never searched/i,
      `an index failure was reported as an ordinary miss: ${res.diagnostics.warning}`
    );
    assert.match(res.diagnostics.warning, /not evidence the series is absent/i);
  });

  test('an empty query is refused with a reason and touches nothing', async () => {
    const adapter = fakeAdapter();
    const res = await provider(adapter).search('   ');
    assert.deepEqual(res.results, []);
    assert.equal(adapter.seen.length, 0, `empty query made requests: ${adapter.seen.join(', ')}`);
    assert.match(res.diagnostics.warning, /no searchable characters/i);
  });
});
