// AsuraScans — the dead host, the ignored `page` param, and the locked chapters that 200.
//
// WHAT THIS PROTECTS.
//
// 1. THE HOST WAS DEAD, AND FAILED OPEN. The provider was pinned to `asuracomic.net`. That host
//    still answers, but it 301s to `https://asurascans.com/` **discarding the path and query** —
//    `curl -sIL https://asuracomic.net/series/solo-leveling` ends at `https://asurascans.com/`.
//    So every request fetched the HOMEPAGE and ran cheerio over it. `fetchMangaInfo('anything')`
//    did not throw; it RESOLVED, with `{title: 'Popular', chapters: [], image: undefined}`. The
//    old `/series/...` route is a hard 404 now; the site uses `/comics/<slug>-7e1f454a`.
//    The fake transport below rejects any URL it does not recognise, so re-pinning the host — or
//    reintroducing the `/series/` route — makes these tests fail with the offending URL named.
//
// 2. `page` IS NOT A PARAMETER ON THIS API. `?page=2`, `?page=3`, `?page=99` all return page ONE
//    with `meta.has_more: true` forever (verified live: identical `data[0].slug` at every page).
//    The real cursor is `offset`. A search built on `page=` paginates in place and looks fine.
//    `limit` is capped at 50 and does NOT clamp above it — `limit=51` silently yields 20 rows.
//
// 3. LOCKED CHAPTERS ANSWER HTTP 200 WITH `pages: null`. An early-access chapter comes back
//    `{is_locked: true, chapter: {pages: null, page_count: 0, is_premium: true}}` on a 200 —
//    captured live from `got-dropped-into-a-ghost-story-still-gotta-work` ch.30. Mapping `pages`
//    naively gives `[]` and a blank reader: the exact MangaDex defect wave 1 fixed. So this throws
//    (the house convention — an aggregator's fallthrough keys on the throw) and `fetchMangaInfo`
//    pre-flags those chapters `readable: false` + `externalUrl`, which is what
//    `manga-aggregator.chapterUnavailability` actually reads.
//
// 4. THE HTML FALLBACK IS REAL, NOT SCAFFOLDING. `api.asurascans.com` is a bare unauthenticated
//    subdomain — the first thing an operator firewalls — and with no pages the provider is worth
//    nothing. The same list is server-rendered into the chapter page's single `<astro-island>`.
//    Both paths are exercised here, including the case where the island itself reports a lock.
//
// 5. `data` IS `null` PAST THE LAST PAGE, not `[]`, and `meta.has_more` is OMITTED rather than
//    sent as `false`. Either one is a TypeError or an infinite scroll if assumed away.
//
// Offline: every HTTP call is served by a fake axios adapter installed on the provider's own axios
// instance, so the real request wiring (URLs, headers) is exercised with no network. Fixtures are
// trimmed from live captures on 2026-08-14. Live checking is what the ts-node probe is for.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/manga/asurascans.js');
const AsuraScans = mod.default ?? mod;
const { USER_AGENT } = require('../dist/utils/utils.js');

// ---------------------------------------------------------------------------- fake transport

/**
 * axios adapter over a {url-substring → response} map, longest match wins. A value may be
 * `{ __status, __body }` to reject the way axios does for a non-2xx, or a plain body for a 200.
 * An unmatched URL REJECTS — that is what makes a reverted host literal visible.
 * `seen` records url + headers of every request so the tests can assert what was actually sent.
 */
const fakeAdapter = routes => {
  const seen = [];
  const adapter = async config => {
    const url = config.url;
    seen.push({ url, headers: config.headers ?? {} });
    const hit = Object.keys(routes)
      .filter(k => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (hit === undefined) {
      const err = new Error(`ECONNREFUSED ${url}`);
      err.isAxiosError = true;
      err.code = 'ECONNREFUSED';
      err.config = config;
      throw err;
    }
    const route = routes[hit];
    if (route && route.__status) {
      const err = new Error(`Request failed with status code ${route.__status}`);
      err.isAxiosError = true;
      err.code = 'ERR_BAD_REQUEST';
      err.config = config;
      err.response = { status: route.__status, data: route.__body ?? {}, headers: {}, config };
      throw err;
    }
    return { data: route, status: 200, statusText: 'OK', headers: {}, config };
  };
  adapter.seen = seen;
  return adapter;
};

const provider = adapter => {
  const p = new AsuraScans();
  p.client.defaults.adapter = adapter;
  return p;
};

const API = 'https://api.asurascans.com/api';
const WWW = 'https://asurascans.com';

// ---------------------------------------------------------------------------- astro fixtures

/**
 * Astro v5 tuple encoding, faithful to `decodeAstroProps` in src/utils/embedded-json.ts:
 * scalars are `[0, v]`, arrays are `[1, [ ...tuples ]]`, objects are `[0, {k: tuple}]`, and a
 * bare `[0]` is `undefined`. Matches the real attribute byte-for-byte in shape — see the live
 * capture quoted in the ISLAND fixture below.
 */
const astroTuple = v => {
  if (v === undefined) return [0];
  if (Array.isArray(v)) return [1, v.map(astroTuple)];
  if (v !== null && typeof v === 'object') return [0, astroValue(v)];
  return [0, v];
};
const astroValue = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, astroTuple(v)]));

/** The one <astro-island> a chapter page carries, in the real attribute order and escaping. */
const chapterHtml = props => {
  const attr = JSON.stringify(astroValue(props)).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return (
    '<!DOCTYPE html><html><head><title>AsuraScans</title></head><body>' +
    '<astro-island uid="Zw51TD" prefix="r1" component-url="/_astro/ChapterReader.B6AYUpQi.js" ' +
    'component-export="default" renderer-url="/_astro/client.D_Es0amM.js" ' +
    `props="${attr}" ssr="" client="load" opts="{&quot;name&quot;:&quot;ChapterReader&quot;}">` +
    '<div class="reader"></div></astro-island></body></html>'
  );
};

// ---------------------------------------------------------------------------- json fixtures

const page = (n, dir = 'solo-leveling', chap = 1) => ({
  url: `https://cdn.asurascans.com/asura-images/chapters/${dir}/${chap}/${String(n).padStart(3, '0')}.webp?v=1770499638`,
  width: 720,
  height: 4000,
});
const SOLO_PAGES = [1, 2, 3].map(n => page(n));

const SOLO_SERIES = {
  recommended_series: [
    {
      id: 1943,
      slug: 'return-of-the-mount-hua-sect',
      title: 'Return of the Mount Hua Sect',
      // NOTE: recommendation rows say `cover_url`; list rows say `cover`. Both are real.
      cover_url: 'https://cdn.asurascans.com/asura-images/covers/return-of-the-mount-hua-sect.c0cbf9.webp',
      type: 'manhwa',
      status: 'ongoing',
      chapter_count: 181,
      rating: 9.81285140562249,
      public_url: '/comics/return-of-the-mount-hua-sect-7e1f454a',
    },
  ],
  series: {
    id: 1955,
    slug: 'solo-leveling',
    title: 'Solo Leveling',
    alt_titles: ['Ore dake Level Up na Ken', '나 혼자만 레벨업'],
    description: '<p>10 years ago, after &#8220;the Gate&#8221; opened.</p><p>Second paragraph.</p>',
    cover: 'https://cdn.asurascans.com/asura-images/covers/solo-leveling.c27830.webp',
    banner: 'https://cdn.asurascans.com/asura-images/banners/solo-leveling.b0f7b9.webp',
    status: 'completed',
    type: 'manhwa',
    author: '추공 (Chugong)',
    artist: 'REDICE STUDIO',
    rating: 9.77649837614408,
    chapter_count: 201,
    last_chapter_at: '2024-07-13T02:15:04Z',
    public_url: '/comics/solo-leveling-7e1f454a',
    genres: [
      { id: 1, name: 'Action', slug: 'action' },
      { id: 16, name: 'Fantasy', slug: 'fantasy' },
    ],
  },
};

const SOLO_CHAPTERS = {
  data: [
    {
      id: 142312,
      series_id: 1955,
      number: 200,
      title: 'Side Story 21 { THE END }',
      // the chapter's own slug is a UUID on old series and `chapter-139` on new ones — unusable
      // as an addressing key, which is why the provider addresses by `number`.
      slug: 'e85021f4-d477-4bc9-b2da-29b56e031f6b',
      page_count: 15,
      is_premium: false,
      published_at: '2024-07-13T02:15:04Z',
      view_count: 65238,
      series_slug: 'solo-leveling',
      is_locked: false,
    },
    {
      id: 142197,
      series_id: 1955,
      number: 1,
      slug: '8cefbb44-d121-49e6-82d7-389e92616ee8',
      page_count: 22,
      is_premium: false,
      published_at: '2023-03-20T22:07:54Z',
      view_count: 97362,
      series_slug: 'solo-leveling',
      is_locked: false,
    },
    // chapter numbers really are fractional in this catalogue
    {
      id: 142195,
      series_id: 1955,
      number: 0.5,
      slug: 'chapter-0-5',
      page_count: 7,
      is_premium: false,
      published_at: '2023-03-20T22:07:53Z',
      view_count: 100,
      series_slug: 'solo-leveling',
      is_locked: false,
    },
    // ...and chapter 0 exists, which is why a falsy-number check would drop a real chapter
    {
      id: 142192,
      series_id: 1955,
      number: 0,
      slug: '382b6bb7-45fa-4680-8dc8-5fa736546ffc',
      page_count: 12,
      is_premium: false,
      published_at: '2023-03-20T22:07:52Z',
      view_count: 129104,
      series_slug: 'solo-leveling',
      is_locked: false,
    },
  ],
};

const soloChapterOne = () => ({
  data: {
    access_gate: '',
    is_locked: false,
    unlock_time: null,
    comment_count: 142,
    chapter: {
      id: 142197,
      series_id: 1955,
      number: 1,
      slug: '8cefbb44-d121-49e6-82d7-389e92616ee8',
      pages: SOLO_PAGES,
      page_count: SOLO_PAGES.length,
      is_premium: false,
      published_at: '2023-03-20T22:07:54Z',
      series_slug: 'solo-leveling',
    },
    series: { id: 1955, slug: 'solo-leveling', title: 'Solo Leveling', public_url: '/comics/solo-leveling-7e1f454a' },
  },
});

// The live shape of an early-access chapter: HTTP 200, `pages: null`, `page_count: 0`.
const LOCKED_SLUG = 'got-dropped-into-a-ghost-story-still-gotta-work';
const LOCKED_CHAPTER_RESPONSE = {
  data: {
    access_gate: '',
    is_locked: true,
    unlock_time: '2026-08-15T00:05:48.578215Z',
    comment_count: 0,
    chapter: {
      id: 260782,
      series_id: 6066,
      number: 30,
      slug: 'chapter-30',
      pages: null,
      page_count: 0,
      is_premium: true,
      early_access_until: '2026-08-15T00:05:48.578215Z',
      published_at: '2026-08-14T18:05:48.578215Z',
      series_slug: LOCKED_SLUG,
    },
  },
};

const LOCKED_SERIES = {
  series: {
    id: 6066,
    slug: LOCKED_SLUG,
    title: 'Got Dropped Into a Ghost Story, Still Gotta Work',
    status: 'ongoing',
    type: 'manhwa',
    public_url: `/comics/${LOCKED_SLUG}-7e1f454a`,
    genres: [],
  },
  recommended_series: [],
};

const LOCKED_SERIES_CHAPTERS = {
  data: [
    {
      id: 260782,
      series_id: 6066,
      number: 30,
      slug: 'chapter-30',
      page_count: 22, // the listing reports a count even though there is nothing to read
      is_premium: true,
      early_access_until: '2026-08-15T00:05:48.578215Z',
      published_at: '2026-08-14T18:05:48.578215Z',
      view_count: 7288,
      series_slug: LOCKED_SLUG,
      is_locked: true,
      unlock_time: '2026-08-15T00:05:48.578215Z',
    },
    {
      id: 260627,
      series_id: 6066,
      number: 29,
      slug: 'chapter-29',
      page_count: 13,
      is_premium: false,
      early_access_until: '2026-08-07T23:10:21.307445Z',
      published_at: '2026-08-07T17:10:21.307445Z',
      view_count: 124955,
      series_slug: LOCKED_SLUG,
      is_locked: false,
    },
  ],
};

const searchRow = (slug, extra = {}) => ({
  id: 2201,
  slug,
  title: slug.replace(/-/g, ' '),
  alt_titles: [],
  cover: `https://cdn.asurascans.com/asura-images/covers/${slug}.d60872.webp`,
  status: 'ongoing',
  type: 'manhwa',
  rating: 9.5,
  chapter_count: 140,
  public_url: `/comics/${slug}-7e1f454a`,
  genres: [],
  latest_chapters: [{ id: 1, number: 139 }, { id: 2, number: 138 }],
  ...extra,
});

const soloRoutes = () => ({
  [`${API}/series/solo-leveling/chapters/1`]: soloChapterOne(),
  [`${API}/series/solo-leveling/chapters/0.5`]: {
    data: { is_locked: false, chapter: { number: 0.5, pages: [page(1, 'solo-leveling', '0-5')] } },
  },
  [`${API}/series/solo-leveling/chapters`]: SOLO_CHAPTERS,
  [`${API}/series/solo-leveling`]: SOLO_SERIES,
});

const lockedRoutes = () => ({
  [`${API}/series/${LOCKED_SLUG}/chapters/30`]: LOCKED_CHAPTER_RESPONSE,
  [`${API}/series/${LOCKED_SLUG}/chapters`]: LOCKED_SERIES_CHAPTERS,
  [`${API}/series/${LOCKED_SLUG}`]: LOCKED_SERIES,
});

const uaOf = headers =>
  typeof headers.get === 'function' ? headers.get('User-Agent') : headers['User-Agent'] ?? headers['user-agent'];

// ------------------------------------------------------------------- 1. the host, and fail-open

describe('AsuraScans talks to the live hosts, and stops resolving for series that do not exist', () => {
  test('every request goes to api.asurascans.com/api — never asuracomic.net, never /series/', async () => {
    const adapter = fakeAdapter(soloRoutes());
    await provider(adapter).fetchMangaInfo('solo-leveling');

    assert.ok(adapter.seen.length >= 2, `expected at least the detail + chapters calls, saw ${adapter.seen.length}`);
    for (const { url } of adapter.seen) {
      assert.ok(url.startsWith(`${API}/`), `request did not go to the JSON API: ${url}`);
      assert.doesNotMatch(url, /asuracomic\.net/, `the dead host is back: ${url}`);
      // `https://asurascans.com/series/...` is a hard 404 now; `/comics/` replaced it.
      assert.doesNotMatch(url, /asurascans\.com\/series\//, `the retired /series/ route is back: ${url}`);
    }
  });

  test('an unknown series REJECTS — it used to resolve with the homepage', async () => {
    // Live: GET /api/series/<unknown> -> 404 {"error":"series not found"}. The old code followed a
    // path-discarding 301 to the homepage and returned {title:'Popular', chapters:[]} with no error.
    const p = provider(
      fakeAdapter({
        [`${API}/series/this-does-not-exist`]: { __status: 404, __body: { error: 'series not found' } },
      })
    );
    await assert.rejects(p.fetchMangaInfo('this-does-not-exist'), err => {
      assert.match(err.message, /AsuraScans/);
      assert.match(err.message, /404/, 'must report the status');
      assert.match(err.message, /series not found/, "must surface the API's own message");
      return true;
    });
  });

  test('a series id may be a slug, a /comics path, or a full site URL', async () => {
    for (const id of [
      'solo-leveling',
      '/comics/solo-leveling',
      'comics/solo-leveling',
      'https://asurascans.com/comics/solo-leveling',
    ]) {
      const info = await provider(fakeAdapter(soloRoutes())).fetchMangaInfo(id);
      assert.equal(info.id, 'solo-leveling', `id form "${id}" did not resolve`);
      assert.equal(info.title, 'Solo Leveling');
    }
  });

  test('the canonical id comes back from the API, so ids stay stable across the `-7e1f454a` form', async () => {
    // the suffix is a SITE-WIDE CONSTANT, identical on every series; the API echoes the bare slug
    const routes = { ...soloRoutes(), [`${API}/series/solo-leveling-7e1f454a`]: SOLO_SERIES };
    routes[`${API}/series/solo-leveling-7e1f454a/chapters`] = SOLO_CHAPTERS;
    const info = await provider(fakeAdapter(routes)).fetchMangaInfo('solo-leveling-7e1f454a');
    assert.equal(info.id, 'solo-leveling');
    assert.ok(
      info.chapters.every(c => c.id.startsWith('solo-leveling/chapter/')),
      'chapter ids must be built from the canonical slug, not the suffixed one'
    );
  });
});

// ---------------------------------------------------------------------------- 2. search paging

describe('AsuraScans paginates with `offset` — the API ignores `page`', () => {
  const searchRoute = (rows, meta) => ({ [`${API}/series?search=`]: { data: rows, meta } });

  test('page 2 asks for offset=20 and does not send a `page` param at all', async () => {
    // Live: ?page=2 / ?page=3 / ?page=99 all return page ONE with has_more:true forever.
    const adapter = fakeAdapter(searchRoute([searchRow('a')], { total: 326, per_page: 20, has_more: true }));
    await provider(adapter).search('solo', 2);

    const url = adapter.seen[0].url;
    assert.match(url, /[?&]offset=20(&|$)/, `page 2 must become offset=20: ${url}`);
    assert.doesNotMatch(url, /[?&]page=/, `\`page\` is ignored by this API and must not be sent: ${url}`);
    assert.match(url, /[?&]limit=20(&|$)/);
  });

  test('offset tracks the limit, not a hardcoded 20', async () => {
    const adapter = fakeAdapter(searchRoute([], { total: 326, per_page: 5, has_more: true }));
    await provider(adapter).search('solo', 3, 5);
    assert.match(adapter.seen[0].url, /[?&]offset=10(&|$)/, adapter.seen[0].url);
  });

  test('a limit above 50 is refused rather than silently reduced to 20', async () => {
    // Live: limit=50 -> 50 rows; limit=51, 100, 200, 0, -1 -> 20 rows. It does not clamp.
    const p = provider(fakeAdapter(searchRoute([], { total: 1 })));
    await assert.rejects(p.search('solo', 1, 51), /limit must be an integer in 1\.\.50/);
    await assert.rejects(p.search('solo', 1, 0), /limit must be an integer in 1\.\.50/);
    await assert.rejects(p.search('solo', 0), /page must be a positive integer/);
    // 50 is fine
    await p.search('solo', 1, 50);
  });

  test('`has_more` omitted on the last page means no next page', async () => {
    // The API omits the key entirely rather than sending false — `!== false` would loop forever.
    const rows = [searchRow('x'), searchRow('y')];
    const res = await provider(fakeAdapter(searchRoute(rows, { total: 322, per_page: 20 }))).search('a', 17);
    assert.equal(res.hasNextPage, false);
    assert.equal(res.totalResults, 322);
    assert.equal(res.totalPages, 17);
  });

  test('`data: null` past the last page is an empty result set, not a crash', async () => {
    const res = await provider(fakeAdapter(searchRoute(null, { total: 326, per_page: 20 }))).search('a', 99);
    assert.deepEqual(res.results, []);
    assert.equal(res.hasNextPage, false);
  });

  test('search rows map to results, cover included, latestChapter from latest_chapters', async () => {
    const rows = [searchRow('solo-farming-in-the-tower')];
    const res = await provider(fakeAdapter(searchRoute(rows, { total: 1, per_page: 20 }))).search('solo');
    assert.equal(res.results.length, 1);
    const r = res.results[0];
    assert.equal(r.id, 'solo-farming-in-the-tower');
    assert.equal(r.image, 'https://cdn.asurascans.com/asura-images/covers/solo-farming-in-the-tower.d60872.webp');
    assert.equal(r.status, 'Ongoing');
    assert.equal(r.latestChapter, '139');
    assert.equal(r.url, 'https://asurascans.com/comics/solo-farming-in-the-tower-7e1f454a');
  });

  test('the query is URL-encoded, so a multi-word search is not a malformed URL', async () => {
    const adapter = fakeAdapter(searchRoute([], { total: 0 }));
    await provider(adapter).search('solo leveling & co');
    assert.match(adapter.seen[0].url, /search=solo%20leveling%20%26%20co/, adapter.seen[0].url);
  });
});

// ------------------------------------------------------------------------------- 3. manga info

describe('AsuraScans maps the series document', () => {
  test('the whole info block comes back populated', async () => {
    const info = await provider(fakeAdapter(soloRoutes())).fetchMangaInfo('solo-leveling');

    assert.equal(info.title, 'Solo Leveling');
    assert.equal(info.status, 'Completed');
    assert.equal(info.type, 'manhwa');
    assert.equal(info.image, 'https://cdn.asurascans.com/asura-images/covers/solo-leveling.c27830.webp');
    assert.equal(info.cover, 'https://cdn.asurascans.com/asura-images/banners/solo-leveling.b0f7b9.webp');
    assert.deepEqual(info.genres, ['Action', 'Fantasy']);
    assert.equal(info.artist, 'REDICE STUDIO');
    assert.equal(info.chapterCount, 201);
    assert.equal(info.url, 'https://asurascans.com/comics/solo-leveling-7e1f454a');
    assert.deepEqual(info.altTitles, ['Ore dake Level Up na Ken', '나 혼자만 레벨업']);
  });

  test('the single `author` field is not split on a separator it does not use', async () => {
    // the old code did `.split('/')` on scraped text; the API has one author string.
    const info = await provider(fakeAdapter(soloRoutes())).fetchMangaInfo('solo-leveling');
    assert.deepEqual(info.authors, ['추공 (Chugong)']);
  });

  test('the HTML description is flattened to text with paragraph breaks kept', async () => {
    const info = await provider(fakeAdapter(soloRoutes())).fetchMangaInfo('solo-leveling');
    assert.doesNotMatch(info.description, /</, `raw markup leaked into description: ${info.description}`);
    assert.match(info.description, /^10 years ago, after “the Gate” opened\./);
    // `load(html).text()` alone welds the two <p> blocks into "...opened.Second paragraph."
    assert.match(info.description, /opened\.\n+Second paragraph\.$/, JSON.stringify(info.description));
  });

  test('recommendations use `cover_url`, the key the list endpoint does not use', async () => {
    const info = await provider(fakeAdapter(soloRoutes())).fetchMangaInfo('solo-leveling');
    assert.equal(info.recommendations.length, 1);
    assert.equal(info.recommendations[0].id, 'return-of-the-mount-hua-sect');
    assert.equal(
      info.recommendations[0].image,
      'https://cdn.asurascans.com/asura-images/covers/return-of-the-mount-hua-sect.c0cbf9.webp'
    );
  });

  test('every status the catalogue actually uses maps to a real MediaStatus', async () => {
    // counted over the live catalogue: ongoing, dropped, hiatus, completed, axed.
    const cases = {
      ongoing: 'Ongoing',
      completed: 'Completed',
      hiatus: 'Hiatus',
      dropped: 'Cancelled',
      axed: 'Cancelled',
      '': 'Unknown',
    };
    for (const [api, expected] of Object.entries(cases)) {
      const routes = {
        [`${API}/series/s/chapters`]: { data: [] },
        [`${API}/series/s`]: { series: { slug: 's', title: 'S', status: api, genres: [] }, recommended_series: [] },
      };
      const info = await provider(fakeAdapter(routes)).fetchMangaInfo('s');
      assert.equal(info.status, expected, `status "${api}"`);
    }
  });

  test('chapter 0 and chapter 0.5 both survive the listing', async () => {
    const info = await provider(fakeAdapter(soloRoutes())).fetchMangaInfo('solo-leveling');
    const ids = info.chapters.map(c => c.id);
    assert.deepEqual(ids, [
      'solo-leveling/chapter/200',
      'solo-leveling/chapter/1',
      'solo-leveling/chapter/0.5',
      'solo-leveling/chapter/0',
    ]);
    // a fractional number must not be floored, and chapter 0 must not be dropped as falsy
    assert.equal(info.chapters[2].chapterNumber, '0.5');
    assert.equal(info.chapters[3].chapterNumber, '0');
  });

  test('a chapter with no title still gets one, from its number', async () => {
    const info = await provider(fakeAdapter(soloRoutes())).fetchMangaInfo('solo-leveling');
    assert.equal(info.chapters[0].title, 'Side Story 21 { THE END }');
    assert.equal(info.chapters[1].title, 'Chapter 1');
  });

  test('the info block carries the headers the image hosts want', async () => {
    // all three asurascans hosts 403 a deny-listed library UA (Python-urllib verified live)
    const info = await provider(fakeAdapter(soloRoutes())).fetchMangaInfo('solo-leveling');
    assert.equal(info.headers['User-Agent'], USER_AGENT);
  });
});

// --------------------------------------------------------------------------- 4. chapter pages

describe('AsuraScans reads chapter pages off the JSON API', () => {
  test('pages map in order, with page numbers re-derived from array position', async () => {
    const pages = await provider(fakeAdapter(soloRoutes())).fetchChapterPages('solo-leveling/chapter/1');
    assert.equal(pages.length, 3);
    assert.deepEqual(
      pages.map(p => p.page),
      [1, 2, 3]
    );
    assert.equal(pages[0].img, SOLO_PAGES[0].url);
  });

  test('the `?v=` cache-buster is passed through untouched', async () => {
    // stripping it still returns byte-identical content (measured), so there is nothing to gain
    // by rewriting the URL and a real risk in guessing at a query the CDN might start using.
    const pages = await provider(fakeAdapter(soloRoutes())).fetchChapterPages('solo-leveling/chapter/1');
    assert.match(pages[0].img, /\?v=1770499638$/);
  });

  test('each page carries the User-Agent the CDN wants', async () => {
    const pages = await provider(fakeAdapter(soloRoutes())).fetchChapterPages('solo-leveling/chapter/1');
    assert.equal(pages[0].headers['User-Agent'], USER_AGENT);
  });

  test('a fractional chapter number reaches the URL as `0.5`, not `0`', async () => {
    const adapter = fakeAdapter(soloRoutes());
    const pages = await provider(adapter).fetchChapterPages('solo-leveling/chapter/0.5');
    assert.equal(adapter.seen[0].url, `${API}/series/solo-leveling/chapters/0.5`);
    assert.equal(pages.length, 1);
  });

  test('a chapter id may also be a full site URL or a /comics path', async () => {
    for (const id of [
      'solo-leveling/chapter/1',
      '/comics/solo-leveling/chapter/1',
      'solo-leveling/1',
      'https://asurascans.com/comics/solo-leveling/chapter/1',
    ]) {
      const pages = await provider(fakeAdapter(soloRoutes())).fetchChapterPages(id);
      assert.equal(pages.length, 3, `chapter id form "${id}" did not resolve`);
    }
  });

  test('an unparseable chapter id is named, not passed into a URL', async () => {
    const p = provider(fakeAdapter(soloRoutes()));
    for (const bad of ['', 'solo-leveling', 'a/b/c/d/e']) {
      await assert.rejects(p.fetchChapterPages(bad), /is not a usable chapter id/, `"${bad}" was accepted`);
    }
  });
});

// ------------------------------------------------------------------------- 5. locked chapters

describe('AsuraScans refuses to pass a locked chapter off as a zero-page one', () => {
  test('fetchChapterPages THROWS on an early-access chapter instead of returning []', async () => {
    // live shape: HTTP 200, is_locked:true, chapter.pages:null, page_count:0. Nothing errors.
    const p = provider(fakeAdapter(lockedRoutes()));
    await assert.rejects(p.fetchChapterPages(`${LOCKED_SLUG}/chapter/30`), err => {
      assert.match(err.message, /locked behind early access/i, 'must say why it is unreadable');
      assert.match(err.message, /is_premium: true/, 'must report the premium flag');
      assert.match(err.message, /2026-08-15T00:05:48/, 'must say when it unlocks');
      assert.match(err.message, new RegExp(`${WWW}/comics/${LOCKED_SLUG}/chapter/30`), 'must say where to read it');
      assert.match(err.message, /readable: false/, 'must point at the cheap pre-flight signal');
      return true;
    });
  });

  test('a locked chapter does NOT trigger the HTML fallback — a lock is an answer, not a fault', async () => {
    const adapter = fakeAdapter(lockedRoutes());
    await assert.rejects(provider(adapter).fetchChapterPages(`${LOCKED_SLUG}/chapter/30`));
    assert.equal(adapter.seen.length, 1, `expected exactly one request, saw ${adapter.seen.map(s => s.url)}`);
  });

  test('fetchMangaInfo pre-flags locked chapters with the fields the aggregator reads', async () => {
    const info = await provider(fakeAdapter(lockedRoutes())).fetchMangaInfo(LOCKED_SLUG);
    const locked = info.chapters.find(c => c.chapterNumber === '30');
    const free = info.chapters.find(c => c.chapterNumber === '29');

    // `readable === false` + `externalUrl` is what manga-aggregator.chapterUnavailability keys on
    assert.equal(locked.readable, false);
    assert.equal(locked.externalUrl, `${WWW}/comics/${LOCKED_SLUG}/chapter/30`);
    // the listing claims 22 pages for a chapter that serves none — do not repeat the claim
    assert.equal(locked.pages, 0);
    assert.equal(locked.isLocked, true);
    assert.equal(locked.isPremium, true);
    assert.equal(locked.unlockTime, '2026-08-15T00:05:48.578215Z');

    assert.equal(free.readable, true);
    assert.equal(free.externalUrl, null);
    assert.equal(free.pages, 13);
    assert.equal(free.isLocked, false);
  });

  test('a premium chapter whose early-access window has lapsed stays readable', async () => {
    // is_premium is observed only alongside is_locked, but absence of evidence is not evidence:
    // only is_locked may hide a chapter, or every once-paid chapter disappears from the reader.
    const routes = {
      [`${API}/series/x/chapters`]: {
        data: [{ number: 7, page_count: 9, is_premium: true, is_locked: false, series_slug: 'x' }],
      },
      [`${API}/series/x`]: { series: { slug: 'x', title: 'X', status: 'ongoing', genres: [] }, recommended_series: [] },
    };
    const info = await provider(fakeAdapter(routes)).fetchMangaInfo('x');
    assert.equal(info.chapters[0].readable, true);
    assert.equal(info.chapters[0].isPremium, true);
    assert.equal(info.chapters[0].pages, 9);
  });
});

// -------------------------------------------------------------------------- 6. HTML fallback

describe('AsuraScans falls back to the ChapterReader island when the JSON API is unreachable', () => {
  const ISLAND_PROPS = {
    seriesSlug: 'solo-leveling-7e1f454a',
    seriesId: 1955,
    seriesName: 'Solo Leveling',
    seriesCover: 'https://cdn.asurascans.com/asura-images/covers/solo-leveling.c27830.webp',
    chapterId: 142197,
    chapterName: '1',
    chapterNumber: 1,
    chapterTitle: undefined,
    pages: SOLO_PAGES,
    prevChapter: null,
    nextChapter: null,
    // A5's warning: chapterList[].series_id and page_count are 0 on the wire. Nothing reads them.
    chapterList: [{ id: 257179, series_id: 0, number: 201, slug: 'chapter-201', page_count: 0 }],
    commentsEnabled: true,
    recommendedSeries: [],
    commentCount: 142,
    isLocked: false,
    isPremium: false,
    unlockTime: null,
    linkedNovel: null,
  };

  const htmlRoute = (props = ISLAND_PROPS) => ({
    [`${WWW}/comics/solo-leveling/chapter/1`]: chapterHtml(props),
  });

  test('an API failure is recovered from the island, with the same page list', async () => {
    const adapter = fakeAdapter({
      [`${API}/series/solo-leveling/chapters/1`]: { __status: 503 },
      ...htmlRoute(),
    });
    const pages = await provider(adapter).fetchChapterPages('solo-leveling/chapter/1');

    assert.equal(pages.length, 3);
    assert.equal(pages[0].img, SOLO_PAGES[0].url);
    assert.deepEqual(
      pages.map(p => p.page),
      [1, 2, 3]
    );
    assert.equal(adapter.seen.length, 2, 'the fallback costs exactly one extra request');
    assert.equal(adapter.seen[1].url, `${WWW}/comics/solo-leveling/chapter/1`);
  });

  test('an API 200 carrying no pages for an unlocked chapter also falls back', async () => {
    // shape drift, not a lock: `is_locked:false` but `pages` gone or renamed.
    const adapter = fakeAdapter({
      [`${API}/series/solo-leveling/chapters/1`]: { data: { is_locked: false, chapter: { number: 1, pages: [] } } },
      ...htmlRoute(),
    });
    const pages = await provider(adapter).fetchChapterPages('solo-leveling/chapter/1');
    assert.equal(pages.length, 3);
  });

  test('a lock reported by the ISLAND is honoured too — the fallback cannot launder one', async () => {
    const adapter = fakeAdapter({
      [`${API}/series/solo-leveling/chapters/1`]: { __status: 503 },
      ...htmlRoute({ ...ISLAND_PROPS, pages: [], isLocked: true, isPremium: true, unlockTime: '2026-08-15T00:05:48Z' }),
    });
    await assert.rejects(
      provider(adapter).fetchChapterPages('solo-leveling/chapter/1'),
      /locked behind early access/i
    );
  });

  test('a page with no ChapterReader island reports THAT, naming the url', async () => {
    const adapter = fakeAdapter({
      [`${API}/series/solo-leveling/chapters/1`]: { __status: 503 },
      [`${WWW}/comics/solo-leveling/chapter/1`]: '<!DOCTYPE html><html><body>Just a challenge page.</body></html>',
    });
    await assert.rejects(provider(adapter).fetchChapterPages('solo-leveling/chapter/1'), err => {
      assert.match(err.message, /no embedded JSON found/i);
      assert.match(err.message, /not-found/);
      assert.match(err.message, /comics\/solo-leveling\/chapter\/1/, 'the error must name the page');
      return true;
    });
  });

  test('when both paths fail, the error names both — not just the last one', async () => {
    const adapter = fakeAdapter({ [`${API}/series/solo-leveling/chapters/1`]: { __status: 503 } });
    await assert.rejects(provider(adapter).fetchChapterPages('solo-leveling/chapter/1'), err => {
      assert.match(err.message, /JSON API:/);
      assert.match(err.message, /HTML fallback:/);
      assert.match(err.message, /503/);
      return true;
    });
  });
});

// ------------------------------------------------------------------------------ 7. User-Agent

describe('AsuraScans sends an explicit User-Agent everywhere', () => {
  test('all three hosts deny-list library UAs, so every request carries the shared one', async () => {
    // measured: `Python-urllib/3.14` -> 403 from api., cdn. AND the HTML host; no UA at all,
    // `Consumet/1.0`, `axios/1.6.0` and a Chrome UA all -> 200. Relying on the transport's
    // default UA is how this becomes a 403 the day the transport changes.
    const adapter = fakeAdapter({
      ...soloRoutes(),
      [`${API}/series?search=`]: { data: [], meta: { total: 0 } },
    });
    const p = provider(adapter);
    await p.search('solo');
    await p.fetchMangaInfo('solo-leveling');
    await p.fetchChapterPages('solo-leveling/chapter/1');

    assert.ok(adapter.seen.length >= 4, `expected several requests, saw ${adapter.seen.length}`);
    for (const { url, headers } of adapter.seen)
      assert.equal(uaOf(headers), USER_AGENT, `no explicit User-Agent on ${url}`);
  });

  test('the HTML fallback request carries it too', async () => {
    const adapter = fakeAdapter({
      [`${API}/series/solo-leveling/chapters/1`]: { __status: 503 },
      [`${WWW}/comics/solo-leveling/chapter/1`]: chapterHtml({ pages: SOLO_PAGES, isLocked: false }),
    });
    await provider(adapter).fetchChapterPages('solo-leveling/chapter/1');
    assert.equal(uaOf(adapter.seen[1].headers), USER_AGENT);
  });
});
