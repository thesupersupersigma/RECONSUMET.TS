// FlameComics — the moved host, the Next.js data model, and the four silent-wrong-answer traps in it.
//
// WHAT THIS PROTECTS.
//
// 1. THE HOST. `flamescans.org` is not FlameScans any more — it is a parked ad-monetization domain
//    whose every path answers with the same ~480-byte stub over **HTTP 200**. Because it is a 200,
//    axios does not throw and the old MangaThemesia selectors just matched nothing, so search, info
//    and pages all "succeeded" and returned empty. The service is alive at `flamecomics.xyz`. The
//    fake transport below rejects any request to the dead host, so reverting the host literal makes
//    these tests fail with the offending URL named rather than passing on empty results.
//
// 2. `images` IS AN INDEX-KEYED OBJECT, NOT AN ARRAY. `props.pageProps.chapter.images` is
//    `{"0":{…},"1":{…}}`. Two ways to get this wrong, both silent: `.map` is not a function on it
//    (loud, at least), and `Object.values()` / `for…in` trusts enumeration order to be page order.
//    The fixture here deliberately spells its keys OUT OF ORDER and runs past nine pages, so a
//    lexicographic or insertion-order read puts page 10 before page 2 and the assertion catches it.
//
// 3. NOVELS HAVE NO `series_id`. 13 of the 166 catalogue entries are "Novel"/"Web Novel" and carry
//    `novel_id` instead — they live at `/novel/{id}`, a different route with no page images. A naive
//    `String(entry.series_id)` mints the literal id `"undefined"` for each, i.e. search hits that
//    404 on the very next call. The fixture includes one, and the test asserts it is dropped.
//
// 4. CHAPTER TOKENS ARE SERIES-SCOPED. A token alone cannot address a chapter: verified live,
//    `/series/2/0195c1a6f06c7d77` and `/series/162/0195c1a6f06c7d77` both 404 while
//    `/series/104/0195c1a6f06c7d77` is 200. So the chapter id is the composite
//    `"{series_id}/{token}"`. A bare token, or a slug id left over from the old flamescans.org
//    provider, must be rejected with an explanatory error rather than pasted into a URL.
//
// Also pinned: the `/_next/data/{buildId}` fast path and its recovery when the buildId rotates; that
// an unreadable chapter THROWS instead of returning `[]` (the mangadex.ts convention); and that a
// remote-chosen image `name` cannot steer the URL off the chapter's own CDN prefix.
//
// Fixtures are trimmed captures from flamecomics.xyz (2026-08-14). Offline: every HTTP call is
// served by a fake axios adapter installed on the provider's own client, so the real provider wiring
// is exercised with no network. Live checking is what the ts-node probes are for; this suite must
// never need the network.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/manga/flamescans.js');
const FlameComics = mod.default ?? mod;

const HOST = 'https://flamecomics.xyz';
const CDN = 'https://cdn.flamecomics.xyz/uploads/images/series';
const DEAD_HOST = 'flamescans.org';
const BUILD_ID = 'fQQxmOSu5mqEoDWF3CCy7';

/* ------------------------------------------------------------------ *
 * fixtures — trimmed from live captures
 * ------------------------------------------------------------------ */

/** wrap pageProps the way the HTML route ships it */
const nextDataHtml = (page, query, pageProps) =>
  `<!DOCTYPE html><html><head><title>FlameComics</title></head><body><div id="__next"></div>` +
  `<script id="__NEXT_DATA__" type="application/json">` +
  JSON.stringify({
    props: { pageProps },
    page,
    query,
    buildId: BUILD_ID,
    isFallback: false,
    gsp: true,
  }) +
  `</script></body></html>`;

/** and the way the /_next/data route ships it */
const nextDataJson = pageProps => ({ __N_SSG: true, pageProps });

const BROWSE_PROPS = {
  series: [
    {
      series_id: 104,
      title: 'Tyrant of the Tower Defense Game',
      description: 'The tower defense & dungeon offense RPG, I watched the ending of the game…',
      language: 'English',
      type: 'Manhwa',
      categories: ['Action', 'Fantasy', 'Isekai'],
      country: 'KR',
      author: ['Ha Jung', 'Ryueun Garam'],
      artist: ['Gyong'],
      publisher: ['Naver'],
      year: 2022,
      status: 'Ongoing',
      cover: 'thumbnail.jpg',
    },
    {
      series_id: 35,
      title: 'The Little Prince in the Ossuary',
      description: 'Coming soon.',
      type: 'Manhwa',
      categories: ['Drama'],
      author: [''],
      artist: [''],
      year: 2026,
      status: 'Coming Soon',
      cover: 'thumbnail.webp',
    },
    {
      series_id: 162,
      title: 'Got Dropped Into a Ghost Story, Still Gotta Work',
      type: 'Manhwa',
      categories: ['Horror'],
      author: ['Someone'],
      artist: ['Someone'],
      year: 2025,
      status: 'Dropped',
      cover: 'thumbnail.png',
    },
    // THE TRAP: a prose entry. `novel_id`, NO `series_id`. Lives at /novel/5, not /series/5.
    {
      novel_id: 5,
      title: 'Damn Reincarnation',
      description: 'Hamel, a warrior who traveled with his colleagues to exterminate the devil…',
      language: 'English',
      type: 'Web Novel',
      categories: ['Action', 'Fantasy'],
      country: 'KR',
      author: ['Mogma', '목마'],
      artist: [''],
      publisher: ['Kakao'],
      year: 2020,
      status: 'Dropped',
      cover: 'thumbnail.webp',
    },
  ],
  initialFilters: { search: '', order: 'asc', sort: 'title' },
};

const SERIES_104_PROPS = {
  series: {
    series_id: 104,
    title: 'Tyrant of the Tower Defense Game',
    altTitles: ['디펜스 게임의 폭군이 되었다 ', ' I Became the Tyrant of a Defense Game'],
    // the series route wraps its description in markup; the chapter route does not
    description:
      '<p>The tower defense &amp; dungeon offense RPG, I watched the ending of the game on a difficulty that no one has cleared yet.</p>',
    language: 'English',
    type: 'Manhwa',
    tags: ['Action', 'Fantasy', 'Isekai'],
    country: 'KR',
    author: ['Ha Jung', 'Ryueun Garam'],
    artist: ['Gyong'],
    publisher: ['Naver'],
    year: 2022,
    status: 'Ongoing',
    cover: 'thumbnail.jpg',
  },
  chapters: [
    {
      chapter_id: 12083,
      series_id: 104,
      chapter: '194.00',
      title: '',
      cover: 1,
      notice: 0,
      release_date: 1786305204,
      token: '3b0219e8e36b4883',
      edit_time: 1786305204,
    },
    {
      chapter_id: 4088,
      series_id: 104,
      chapter: '1.00',
      title: null,
      cover: 1,
      notice: 0,
      release_date: 1659744000,
      token: '0195c1a6f06c7d77',
      edit_time: 1733532336,
    },
  ],
  gallery: [],
};

/** "Coming Soon": HTTP 200, a real series record, and zero chapters. Not an error, not a lie. */
const SERIES_35_PROPS = {
  series: {
    series_id: 35,
    title: 'The Little Prince in the Ossuary',
    altTitles: [],
    description: 'Coming soon.',
    type: 'Manhwa',
    tags: ['Drama'],
    author: [''],
    artist: [''],
    year: 2026,
    status: 'Coming Soon',
    cover: 'thumbnail.webp',
  },
  chapters: [],
  gallery: [],
};

/**
 * 12 pages, keys spelled OUT OF ORDER on purpose, and past nine so that "10" sorts before "2"
 * lexicographically. `type` is an ARRAY here, matching series 104 live; series 162 sends a bare
 * string for the same field, so nothing may depend on it.
 */
const CHAPTER_IMAGES = {
  '3': { size: 300, type: ['image/jpeg'], name: 'TTDG1-04.jpg', width: 800, height: 1200 },
  '10': { size: 1000, type: ['image/jpeg'], name: 'TTDG1-11.jpg', width: 800, height: 1200 },
  '0': { size: 808044, type: ['image/jpeg'], name: 'TTDG1-01.jpg', width: 1778, height: 1000 },
  '2': { size: 200, type: ['image/jpeg'], name: 'TTDG1-03.jpg', width: 800, height: 1200 },
  '11': { size: 1100, type: ['image/png'], name: 'TDG1-12.png', width: 800, height: 1065 },
  '1': { size: 100, type: ['image/jpeg'], name: 'TTDG1-02.jpg', width: 800, height: 1200 },
  '4': { size: 400, type: ['image/jpeg'], name: 'TTDG1-05.jpg', width: 800, height: 1200 },
  '5': { size: 500, type: ['image/jpeg'], name: 'TTDG1-06.jpg', width: 800, height: 1200 },
  '6': { size: 600, type: ['image/jpeg'], name: 'TTDG1-07.jpg', width: 800, height: 1200 },
  '7': { size: 700, type: ['image/jpeg'], name: 'TTDG1-08.jpg', width: 800, height: 1200 },
  '8': { size: 800, type: ['image/jpeg'], name: 'TTDG1-09.jpg', width: 800, height: 1200 },
  '9': { size: 900, type: ['image/jpeg'], name: 'TTDG1-10.jpg', width: 800, height: 1200 },
};

const chapterProps = (images, extra = {}) => ({
  chapter: {
    series_id: 104,
    chapter_id: 4088,
    chapter: '1.00',
    chapter_title: null,
    images,
    language: 'English',
    draft: 0,
    hidden: 0,
    notice: 0,
    token: '0195c1a6f06c7d77',
    release_date: 1659744000,
    edit_time: 1733532336,
    title: 'Tyrant of the Tower Defense Game',
    cover: 'thumbnail.jpg',
    ...extra,
  },
  token: '0195c1a6f06c7d77',
  previous: null,
  next: '9a81617e4577c9f8',
});

/* ------------------------------------------------------------------ *
 * fake transport
 * ------------------------------------------------------------------ */

/**
 * axios adapter over an ordered [matcher, responder] list. Anything unmatched REJECTS with a 404
 * shaped like axios', which is what flamecomics.xyz genuinely does for a bogus series or token — the
 * fail-closed behaviour that makes this host repairable at all. `seen` records every request URL.
 */
const fakeAdapter = routes => {
  const seen = [];
  const adapter = async config => {
    const url = config.url ?? '';
    seen.push(url);
    if (url.includes(DEAD_HOST)) {
      const err = new Error(`ECONNREFUSED: request to the dead host ${DEAD_HOST} (${url})`);
      err.code = 'ECONNREFUSED';
      throw err;
    }
    for (const [match, body] of routes) {
      if (!url.includes(match)) continue;
      const data = typeof body === 'function' ? body(url) : body;
      return { data, status: 200, statusText: 'OK', headers: {}, config };
    }
    const err = new Error('Request failed with status code 404');
    err.response = { status: 404, statusText: 'Not Found', data: '', headers: {}, config };
    err.config = config;
    throw err;
  };
  adapter.seen = seen;
  return adapter;
};

const provider = adapter => {
  const p = new FlameComics();
  p.client.defaults.adapter = adapter;
  return p;
};

/** the HTML routes only — forces every call through the __NEXT_DATA__ path */
const HTML_ROUTES = [
  [`${HOST}/browse`, nextDataHtml('/browse', {}, BROWSE_PROPS)],
  [`${HOST}/series/104/0195c1a6f06c7d77`, nextDataHtml('/series/[id]/[token]', { id: '104', token: '0195c1a6f06c7d77' }, chapterProps(CHAPTER_IMAGES))],
  [`${HOST}/series/104`, nextDataHtml('/series/[id]', { id: '104' }, SERIES_104_PROPS)],
  [`${HOST}/series/35`, nextDataHtml('/series/[id]', { id: '35' }, SERIES_35_PROPS)],
];

const html = adapter => provider(adapter);

/* ------------------------------------------------------------------ *
 * tests
 * ------------------------------------------------------------------ */

describe('FlameComics: the host moved off flamescans.org', () => {
  test('every request goes to flamecomics.xyz, never the parked domain', async () => {
    const adapter = fakeAdapter(HTML_ROUTES);
    const p = html(adapter);

    await p.search('tyrant');
    const info = await p.fetchMangaInfo('104');
    await p.fetchChapterPages(info.chapters.at(-1).id);

    assert.ok(adapter.seen.length >= 3, `expected at least three requests, saw ${adapter.seen.length}`);
    for (const url of adapter.seen) {
      assert.doesNotMatch(url, /flamescans\.org/, `request went to the dead host: ${url}`);
      assert.match(url, /^https:\/\/flamecomics\.xyz\//, `request left flamecomics.xyz: ${url}`);
    }
  });

  test('the provider reports the live host and the real service name', () => {
    const stats = new FlameComics().toString;
    assert.equal(stats.name, 'FlameComics');
    assert.equal(stats.baseUrl, HOST);
    assert.doesNotMatch(stats.baseUrl, /flamescans\.org/);
    // the registry key in providers/manga/index.ts is still FlameScans, so classPath must match it
    assert.equal(stats.classPath, 'MANGA.FlameScans');
  });

  test('a request to the dead host would reject, so a reverted host literal cannot pass quietly', async () => {
    const adapter = fakeAdapter(HTML_ROUTES);
    await assert.rejects(adapter({ url: `https://${DEAD_HOST}/series/whatever` }), /ECONNREFUSED/);
  });
});

describe('FlameComics search: the catalogue is client-filtered, and 13 entries are not manga', () => {
  test('finds a series and mints a numeric id', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const res = await p.search('tyrant');

    assert.equal(res.totalResults, 1);
    assert.equal(res.results[0].id, '104');
    assert.equal(res.results[0].title, 'Tyrant of the Tower Defense Game');
    assert.equal(res.results[0].image, `${CDN}/104/thumbnail.jpg`);
    assert.equal(res.results[0].status, 'Ongoing');
  });

  test('a NOVEL entry is dropped — it has novel_id, not series_id, and would mint the id "undefined"', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const res = await p.search('Damn Reincarnation');

    // it IS in the catalogue fixture; it must not be in the results
    assert.ok(
      BROWSE_PROPS.series.some(s => s.title === 'Damn Reincarnation'),
      'fixture regression: the novel entry vanished from the catalogue'
    );
    assert.equal(res.totalResults, 0, 'a prose entry was returned as a manga result');
  });

  test('no result ever carries a non-numeric id', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const res = await p.search('a', 1, 100);
    assert.ok(res.results.length > 0, 'fixture regression: nothing matched');
    for (const r of res.results) {
      assert.match(String(r.id), /^\d+$/, `id "${r.id}" is not a numeric series_id`);
      assert.notEqual(String(r.id), 'undefined');
    }
  });

  test('status labels map onto MediaStatus, including the two FlameComics-only ones', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const byId = new Map((await p.search('o', 1, 100)).results.map(r => [r.id, r.status]));
    assert.equal(byId.get('104'), 'Ongoing');
    assert.equal(byId.get('162'), 'Cancelled', 'Dropped should map to CANCELLED');
    assert.equal(byId.get('35'), 'Not yet aired', 'Coming Soon should map to NOT_YET_AIRED');
  });

  test('pagination reports honest totals', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const page1 = await p.search('o', 1, 2);
    assert.equal(page1.results.length, 2);
    assert.equal(page1.currentPage, 1);
    assert.equal(page1.hasNextPage, page1.totalResults > 2);
    assert.equal(page1.totalPages, Math.ceil(page1.totalResults / 2));

    const last = await p.search('o', page1.totalPages, 2);
    assert.equal(last.hasNextPage, false);
  });

  test('a /browse page with no catalogue THROWS — it is a shape change, not zero results', async () => {
    const p = html(fakeAdapter([[`${HOST}/browse`, nextDataHtml('/browse', {}, { initialFilters: {} })]]));
    await assert.rejects(p.search('tyrant'), /carried no series catalogue/);
  });

  test('an empty query is rejected rather than matching the whole catalogue', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    await assert.rejects(p.search('   '), /must not be empty/);
  });
});

describe('FlameComics info: composite chapter ids and a de-marked-up description', () => {
  test('chapter ids carry the series id, because tokens are series-scoped', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const info = await p.fetchMangaInfo('104');

    assert.equal(info.id, '104');
    assert.equal(info.chapters.length, 2);
    for (const c of info.chapters)
      assert.match(c.id, /^104\/[0-9a-f]{16}$/, `chapter id "${c.id}" is not "{series_id}/{token}"`);
    assert.equal(info.chapters[0].id, '104/3b0219e8e36b4883');
    assert.equal(info.chapters.at(-1).id, '104/0195c1a6f06c7d77');
  });

  test('a chapter id round-trips straight back into fetchChapterPages', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const info = await p.fetchMangaInfo('104');
    const pages = await p.fetchChapterPages(info.chapters.at(-1).id);
    assert.equal(pages.length, 12);
  });

  test('titles fall back to the chapter number when the site sends "" or null', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const info = await p.fetchMangaInfo('104');
    assert.equal(info.chapters[0].title, 'Chapter 194.00');
    assert.equal(info.chapters.at(-1).title, 'Chapter 1.00');
  });

  test('the description loses its markup and its entities', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const info = await p.fetchMangaInfo('104');
    assert.doesNotMatch(info.description, /<p>|<\/p>|&amp;/);
    assert.match(info.description, /tower defense & dungeon offense RPG/);
  });

  test('altTitles are trimmed, and metadata survives', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const info = await p.fetchMangaInfo('104');
    assert.deepEqual(info.altTitles, ['디펜스 게임의 폭군이 되었다', 'I Became the Tyrant of a Defense Game']);
    assert.deepEqual(info.genres, ['Action', 'Fantasy', 'Isekai']);
    assert.deepEqual(info.authors, ['Ha Jung', 'Ryueun Garam']);
    assert.equal(info.image, `${CDN}/104/thumbnail.jpg`);
    assert.equal(info.releaseDate, 2022);
    assert.equal(info.chapters[0].releaseDate, new Date(1786305204 * 1000).toISOString());
  });

  test('a "Coming Soon" series is HTTP 200 with zero chapters — reported, not faked', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const info = await p.fetchMangaInfo('35');
    assert.equal(info.title, 'The Little Prince in the Ossuary');
    assert.equal(info.status, 'Not yet aired');
    assert.deepEqual(info.chapters, []);
  });

  test('a slug id from the old provider is rejected with an explanation, not sent as a URL', async () => {
    const adapter = fakeAdapter(HTML_ROUTES);
    const p = html(adapter);
    await assert.rejects(p.fetchMangaInfo('the-tyrant-of-defense-game'), /numeric.*cannot be converted|cannot be converted/s);
    assert.equal(adapter.seen.length, 0, 'a slug id must not reach the network');
  });

  test('a missing series propagates the 404 instead of returning an empty info block', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    await assert.rejects(p.fetchMangaInfo('999999'), /404/);
  });
});

describe('FlameComics pages: the index-keyed images object', () => {
  test('pages come back in NUMERIC key order, not lexicographic or insertion order', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const pages = await p.fetchChapterPages('104/0195c1a6f06c7d77');

    assert.equal(pages.length, 12);
    assert.deepEqual(pages.map(x => x.page), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    // the fixture's keys are shuffled AND run past nine, so "10" precedes "2" lexicographically.
    // File names encode the true order, so read them back.
    assert.equal(pages[0].img, `${CDN}/104/0195c1a6f06c7d77/TTDG1-01.jpg`);
    assert.equal(pages[1].img, `${CDN}/104/0195c1a6f06c7d77/TTDG1-02.jpg`);
    assert.equal(pages[2].img, `${CDN}/104/0195c1a6f06c7d77/TTDG1-03.jpg`);
    assert.equal(pages[10].img, `${CDN}/104/0195c1a6f06c7d77/TTDG1-11.jpg`);
    assert.equal(pages[11].img, `${CDN}/104/0195c1a6f06c7d77/TDG1-12.png`);

    // a lexicographic sort would put page "10" at index 2
    assert.notEqual(pages[2].img, `${CDN}/104/0195c1a6f06c7d77/TTDG1-11.jpg`);
  });

  test('the CDN URL is built from series id + token + name', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const pages = await p.fetchChapterPages('104/0195c1a6f06c7d77');
    for (const page of pages)
      assert.match(
        page.img,
        /^https:\/\/cdn\.flamecomics\.xyz\/uploads\/images\/series\/104\/0195c1a6f06c7d77\/[^/]+$/,
        `page URL left the chapter's CDN prefix: ${page.img}`
      );
  });

  test('page dimensions and byte size are passed through so a caller can budget before fetching', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    const pages = await p.fetchChapterPages('104/0195c1a6f06c7d77');
    assert.equal(pages[0].size, 808044);
    assert.equal(pages[0].width, 1778);
    assert.equal(pages[0].height, 1000);
  });

  test('a `type` sent as a bare string instead of an array changes nothing', async () => {
    // series 104 sends ["image/jpeg"], series 162 sends "image/jpeg" — same week, same field
    const stringTyped = Object.fromEntries(
      Object.entries(CHAPTER_IMAGES).map(([k, v]) => [k, { ...v, type: 'image/jpeg' }])
    );
    const p = html(
      fakeAdapter([
        [`${HOST}/series/104/0195c1a6f06c7d77`, nextDataHtml('/series/[id]/[token]', {}, chapterProps(stringTyped))],
      ])
    );
    const pages = await p.fetchChapterPages('104/0195c1a6f06c7d77');
    assert.equal(pages.length, 12);
    assert.equal(pages[0].img, `${CDN}/104/0195c1a6f06c7d77/TTDG1-01.jpg`);
  });

  test('an image name cannot steer the request off the chapter prefix', async () => {
    const p = html(
      fakeAdapter([
        [
          `${HOST}/series/104/0195c1a6f06c7d77`,
          nextDataHtml('/series/[id]/[token]', {}, chapterProps({ 0: { name: '../../../evil.jpg' } })),
        ],
      ])
    );
    const pages = await p.fetchChapterPages('104/0195c1a6f06c7d77');
    assert.doesNotMatch(pages[0].img, /\/\.\.\//, `path traversal survived into the URL: ${pages[0].img}`);
    assert.match(pages[0].img, /^https:\/\/cdn\.flamecomics\.xyz\/uploads\/images\/series\/104\/0195c1a6f06c7d77\//);
  });
});

describe('FlameComics pages: unreadable chapters throw, they do not return []', () => {
  const withImages = images =>
    html(
      fakeAdapter([
        [`${HOST}/series/104/0195c1a6f06c7d77`, nextDataHtml('/series/[id]/[token]', {}, chapterProps(images))],
      ])
    );

  test('an empty images object throws — [] would render as a successful blank chapter', async () => {
    await assert.rejects(withImages({}).fetchChapterPages('104/0195c1a6f06c7d77'), /not readable/);
  });

  test('images present but with no numbered pages throws', async () => {
    await assert.rejects(
      withImages({ meta: { name: 'x.jpg' } }).fetchChapterPages('104/0195c1a6f06c7d77'),
      /not readable/
    );
  });

  test('a page with no file name throws rather than emitting a broken URL', async () => {
    await assert.rejects(
      withImages({ 0: { name: 'ok.jpg' }, 1: { size: 5 } }).fetchChapterPages('104/0195c1a6f06c7d77'),
      /has no file name/
    );
  });

  test('a chapter document with no chapter record throws', async () => {
    const p = html(
      fakeAdapter([
        [`${HOST}/series/104/0195c1a6f06c7d77`, nextDataHtml('/series/[id]/[token]', {}, { token: 'x' })],
      ])
    );
    await assert.rejects(p.fetchChapterPages('104/0195c1a6f06c7d77'), /carried no chapter record/);
  });

  test('a bare token is rejected before any request — tokens are series-scoped', async () => {
    const adapter = fakeAdapter(HTML_ROUTES);
    const p = html(adapter);
    await assert.rejects(p.fetchChapterPages('0195c1a6f06c7d77'), /\{series_id\}\/\{token\}/);
    assert.equal(adapter.seen.length, 0, 'a bare token must not reach the network');
  });

  test('an old flamescans.org chapter id is rejected with an explanation', async () => {
    const adapter = fakeAdapter(HTML_ROUTES);
    const p = html(adapter);
    await assert.rejects(p.fetchChapterPages('the-tyrant-of-defense-game-chapter-1'), /cannot be converted/);
    assert.equal(adapter.seen.length, 0);
  });

  test('a token under the wrong series propagates the 404', async () => {
    const p = html(fakeAdapter(HTML_ROUTES));
    await assert.rejects(p.fetchChapterPages('2/0195c1a6f06c7d77'), /404/);
  });
});

describe('FlameComics transport: the /_next/data fast path', () => {
  const DATA_ROUTES = [
    [`${HOST}/_next/data/${BUILD_ID}/series/104.json`, nextDataJson(SERIES_104_PROPS)],
    [`${HOST}/_next/data/${BUILD_ID}/browse.json`, nextDataJson(BROWSE_PROPS)],
    ...HTML_ROUTES,
  ];

  test('the first call reads HTML; later calls use the much smaller JSON route', async () => {
    const adapter = fakeAdapter(DATA_ROUTES);
    const p = html(adapter);

    await p.fetchMangaInfo('104');
    assert.equal(adapter.seen.length, 1);
    assert.equal(adapter.seen[0], `${HOST}/series/104`, 'cold start should read the HTML page');

    await p.fetchMangaInfo('104');
    assert.equal(adapter.seen.length, 2);
    assert.equal(
      adapter.seen[1],
      `${HOST}/_next/data/${BUILD_ID}/series/104.json`,
      'warm call should use the buildId data route'
    );
  });

  test('the JSON route yields identical results to the HTML route', async () => {
    const viaHtml = await html(fakeAdapter(HTML_ROUTES)).fetchMangaInfo('104');

    const p = html(fakeAdapter(DATA_ROUTES));
    await p.fetchMangaInfo('104'); // warm the buildId
    const viaJson = await p.fetchMangaInfo('104');

    assert.deepEqual(viaJson, viaHtml);
  });

  test('a rotated buildId is a 404, and the provider recovers through the HTML page', async () => {
    // only the HTML routes exist, so every /_next/data guess 404s
    const adapter = fakeAdapter(HTML_ROUTES);
    const p = html(adapter);

    await p.fetchMangaInfo('104'); // learns the buildId
    const info = await p.fetchMangaInfo('104'); // tries JSON, 404s, falls back

    assert.equal(info.title, 'Tyrant of the Tower Defense Game');
    assert.ok(
      adapter.seen.some(u => u.includes('/_next/data/')),
      'expected the fast path to be attempted'
    );
    assert.equal(adapter.seen.at(-1), `${HOST}/series/104`, 'expected recovery through the HTML page');
  });

  test('a page with no __NEXT_DATA__ throws instead of yielding an empty result', async () => {
    const p = html(fakeAdapter([[`${HOST}/browse`, '<!DOCTYPE html><html><body>parked</body></html>']]));
    await assert.rejects(p.search('tyrant'), /no embedded JSON found|__NEXT_DATA__/);
  });

  test('the ~480-byte HTTP-200 stub the parked domain serves cannot pass as an empty catalogue', async () => {
    // this is verbatim the failure mode that made the old provider silently return []
    const stub =
      '<html><head><script>window.location.replace("https://broker.example/jwt")</script></head><body></body></html>';
    const p = html(fakeAdapter([[`${HOST}/browse`, stub]]));
    await assert.rejects(p.search('tyrant'));
  });
});
