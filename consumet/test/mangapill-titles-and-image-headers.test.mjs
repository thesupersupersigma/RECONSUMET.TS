// MangaPill — search titles must not swallow the alternate-titles block, and every image the
// provider hands out must carry the Referer that its CDN demands.
//
// WHAT THIS PROTECTS.
//
// 1. TITLE CONCATENATION. A mangapill search card's title link holds the primary title in its
//    first <div> and, when the manga has alternate names, a SECOND <div> with them. The original
//    scraper did `$(el).find('div > a > div').text()`, and cheerio's `.text()` concatenates every
//    matched node with no separator — so `search('kaguya')` returned, verbatim:
//
//      "Kaguya-sama - Love Is WarKaguya Wants to be Confessed To, Kaguya-sama wa Kokurasetai - ..."
//
//    It slipped through review because only One Piece was ever tested, and One Piece is one of the
//    minority of entries with NO alt-title div — its card has exactly one <div>, so the bug is
//    invisible on it. The fixtures below therefore carry BOTH shapes on purpose. Do not "simplify"
//    them down to the one-div card.
//
//    The alternate names are kept as `altTitles` (a field `IMangaResult` already declares) rather
//    than thrown away, because title matching downstream wants them. They are kept as the RAW
//    string, not split on the comma mangapill joins them with: real entries contain commas inside
//    a single name ("One Day, out of the Blue, I Got a Gal's Forgiving Wife."), so splitting here
//    would invent titles that do not exist.
//
// 2. MISSING headerForImage. cdn.readdetectiveconan.com sits behind a Cloudflare rule keyed on
//    Referer. Verified live: no Referer, or a foreign one, returns HTTP 403 with a 4582-byte
//    "you have been blocked" HTML page; `Referer: https://mangapill.com` returns the real JPEG
//    (magic ffd8ff). A consumer that just fetches `img` therefore renders an error page. Sibling
//    providers (mangasee123, mangahost, flamescans, ...) all publish
//    `headerForImage: { Referer: baseUrl }`; this provider did not, on search results, manga info,
//    or chapter pages. The header name is `Referer` — the HTTP misspelling, one 'r' — and the
//    value is the bare origin with no trailing slash. Both are asserted, because either being
//    "corrected" breaks it.
//
// Offline: every HTTP call is served by a fake axios adapter installed on the provider's own
// client, so the real selector wiring runs with no network. Fixtures are trimmed copies of live
// mangapill markup (search?q=kaguya, /manga/2120, /chapters/2120-10001000), indentation included —
// the whitespace is load-bearing for the genres parse.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/manga/mangapill.js');
const MangaPill = mod.default ?? mod;

const BASE = 'https://mangapill.com';
const CDN = 'https://cdn.readdetectiveconan.com';

// ---------------------------------------------------------------------------------------------
// fixtures (trimmed from live markup)
// ---------------------------------------------------------------------------------------------

/** a search card. `alts` null => no alt-title div at all, the One Piece shape. */
const card = (id, slug, title, alts, ext = 'jpg') => `
    <div>
        <a href="/manga/${id}/${slug}" class="relative block">
            <figure class="w-full h-52 overflow-hidden bg-card rounded-md">
                <img data-src="${CDN}/file/mangapill/i/${id}.${ext}" alt="${title}" class="text-transparent lazy object-cover w-full h-full"/>
            </figure>
        </a>
        <div class="flex flex-col justify-end">
            <a href="/manga/${id}/${slug}" class="mb-2">
                <div class="mt-3 font-black leading-tight line-clamp-2">${title}</div>
                ${alts === null ? '' : `<div class="line-clamp-2 text-xs text-secondary mt-1">${alts}</div>`}
            </a>
            <div class="flex flex-wrap gap-1 mt-1">
                <div class="text-xs leading-5 bg-purple-500 text-black rounded px-1">manga</div>
                <div class="text-xs leading-5 bg-orange-500 text-black rounded px-1">2015</div>
            </div>
        </div>
    </div>`;

const KAGUYA_ALTS = 'Kaguya Wants to be Confessed To, Kaguya-sama wa Kokurasetai - Tensai-tachi no Renai';

const SEARCH_HTML = `<html><body>
    <div class="container">
        <div class="my-3 grid justify-end gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
            ${card('2120', 'kaguya-sama-love-is-war', 'Kaguya-sama - Love Is War', KAGUYA_ALTS)}
            ${card('5088', 'kaguya-sama-wo-kataritai', 'Kaguya-sama wo Kataritai', 'We Want To Talk About Kaguya', 'jpeg')}
            ${card('2', 'one-piece', 'One Piece', null, 'webp')}
        </div>
    </div>
</body></html>`;

const INFO_HTML = `<html><body>
    <div class="container">
        <div class="flex flex-col sm:flex-row my-3">
            <div class="text-transparent flex-shrink-0 w-60 h-80 relative rounded bg-card mr-3 mb-3 md:mb-0">
                <img data-src="${CDN}/file/mangapill/i/2120.jpg" alt="Kaguya-sama - Love Is War" loading="lazy" class="lazy absolute inset-0 w-full h-full object-cover rounded bg-color-bg-secondary" />
            </div>

            <div class="flex flex-col">
                <div class="mb-3">
                    <h1 class="font-bold text-lg md:text-2xl">Kaguya-sama - Love Is War</h1>
                    <div class="text-sm text-secondary">${KAGUYA_ALTS}</div>
                </div>

                <div class="mb-3">
                    <p class="text-sm text--secondary">Kaguya Shinomiya and Miyuki Shirogane are the members of the student council.</p>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                    <div>
                        <label class="text-secondary">Type</label>
                        <div>manga</div>
                    </div>

                    <div>
                        <label class="text-secondary">Year</label>
                        <div>2015</div>
                    </div>
                </div>

                <div class="mb-3">
                    <label class="text-secondary">Genres</label>

                        <a class="text-sm mr-1 text-brand" href="/search?genre=Comedy">Comedy</a>

                        <a class="text-sm mr-1 text-brand" href="/search?genre=Drama">Drama</a>

                        <a class="text-sm mr-1 text-brand" href="/search?genre=Slice of Life">Slice of Life</a>

                </div>
            </div>
        </div>

        <div class="border border-border rounded">
            <div id="chapters" class="p-3">
                <div data-filter-list class="my-3 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6">
                    <a class="border border-border p-1" href="/chapters/2120-10281000/kaguya-sama-love-is-war-chapter-281" title="...">Chapter 281</a>
                    <a class="border border-border p-1" href="/chapters/2120-10001000/kaguya-sama-love-is-war-chapter-1" title="...">Chapter 1</a>
                </div>
            </div>
        </div>
    </div>
</body></html>`;

const chapterPage = n => `
    <chapter-page>
        <div class="border rounded border-b-0 border-border primary overflow-hidden">
            <div data-summary class="border-b border-border bg-card uppercase text-secondary flex items-center justify-between px-2">
                <svg data-reload class="h-5 w-5"></svg>
                <div class="text-sm">page ${n}/2</div>
                <svg data-remove class="h-5 w-5"></svg>
            </div>
            <div>
                <picture>
                    <img class="js-page" data-src="${CDN}/file/mangap/2120/10001000/${n}.jpg" alt="Chapter 1 Page ${n}" loading="lazy" width="1067" height="1600"/>
                </picture>
            </div>
        </div>
    </chapter-page>`;

const CHAPTER_HTML = `<html><body><div class="container">${chapterPage(1)}${chapterPage(2)}</div></body></html>`;

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------

/** axios adapter over a {url-substring → body} map; anything unmatched rejects. */
const fakeAdapter = routes => {
  const seen = [];
  const adapter = async config => {
    const url = config.url;
    seen.push(url);
    const hit = Object.keys(routes)
      .filter(k => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (hit === undefined) throw new Error(`ECONNREFUSED ${url} (the test must not hit the network)`);
    return { data: routes[hit], status: 200, statusText: 'OK', headers: {}, config };
  };
  adapter.seen = seen;
  return adapter;
};

const ROUTES = {
  '/search?q=': SEARCH_HTML,
  '/manga/2120/kaguya-sama-love-is-war': INFO_HTML,
  '/chapters/2120-10001000/kaguya-sama-love-is-war-chapter-1': CHAPTER_HTML,
};

const provider = (routes = ROUTES) => {
  const p = new MangaPill();
  p.client.defaults.adapter = fakeAdapter(routes);
  return p;
};

describe('MangaPill search separates the primary title from the alternate titles', () => {
  test('a card WITH alt titles yields the primary title alone', async () => {
    const { results } = await provider().search('kaguya');
    assert.equal(results.length, 3);

    // the exact string the bug produced was title + altTitles glued together
    assert.equal(results[0].title, 'Kaguya-sama - Love Is War');
    assert.doesNotMatch(
      results[0].title,
      /Kaguya Wants to be Confessed To/,
      'the alt-titles <div> leaked back into `title` — `.text()` over both divs concatenates them'
    );
    assert.equal(results[1].title, 'Kaguya-sama wo Kataritai');
  });

  test('no result glues its own alternate titles onto its title', async () => {
    const { results } = await provider().search('kaguya');
    for (const r of results) {
      if (!r.altTitles) continue;
      assert.equal(
        r.title.includes(r.altTitles),
        false,
        `title still contains the alt block: ${JSON.stringify(r.title)}`
      );
    }
  });

  test('the alternate titles are kept, verbatim and unsplit, on altTitles', async () => {
    const { results } = await provider().search('kaguya');
    // a string, not an array: mangapill joins names with ', ' but names contain commas themselves
    assert.equal(typeof results[0].altTitles, 'string');
    assert.equal(results[0].altTitles, KAGUYA_ALTS);
    assert.equal(results[1].altTitles, 'We Want To Talk About Kaguya');
  });

  test('a card with NO alt-title div (the One Piece shape) still parses, with no altTitles', async () => {
    const { results } = await provider().search('one piece');
    const onePiece = results.find(r => r.id === '2/one-piece');
    assert.ok(onePiece, `One Piece card missing from ${JSON.stringify(results.map(r => r.id))}`);
    assert.equal(onePiece.title, 'One Piece');
    assert.equal(onePiece.altTitles, undefined);
  });

  test('ids and cover urls are untouched by the title fix', async () => {
    const { results } = await provider().search('kaguya');
    assert.deepEqual(
      results.map(r => r.id),
      ['2120/kaguya-sama-love-is-war', '5088/kaguya-sama-wo-kataritai', '2/one-piece']
    );
    assert.equal(results[0].image, `${CDN}/file/mangapill/i/2120.jpg`);
  });
});

describe('MangaPill publishes the Referer its image CDN requires', () => {
  // exact shape, matching every sibling provider: { Referer: 'https://mangapill.com' }
  const assertHeader = (obj, where) => {
    assert.ok(obj, `${where}: headerForImage is missing — the CDN 403s without it`);
    assert.deepEqual(obj, { Referer: BASE }, `${where}: wrong headerForImage shape`);
    assert.ok(Object.hasOwn(obj, 'Referer'), `${where}: header must be 'Referer' (HTTP's one-r spelling)`);
    assert.doesNotMatch(obj.Referer, /\/$/, `${where}: no trailing slash — the value is the bare origin`);
  };

  test('every search result carries it next to its cover', async () => {
    const { results } = await provider().search('kaguya');
    results.forEach((r, i) => assertHeader(r.headerForImage, `search result ${i}`));
  });

  test('fetchMangaInfo carries it next to the cover it now returns', async () => {
    const info = await provider().fetchMangaInfo('2120/kaguya-sama-love-is-war');
    assert.equal(info.image, `${CDN}/file/mangapill/i/2120.jpg`);
    assertHeader(info.headerForImage, 'fetchMangaInfo');
  });

  test('every chapter page carries it — this is the one a reader actually fetches', async () => {
    const pages = await provider().fetchChapterPages('2120-10001000/kaguya-sama-love-is-war-chapter-1');
    assert.equal(pages.length, 2);
    pages.forEach((p, i) => assertHeader(p.headerForImage, `page ${i}`));
    assert.deepEqual(
      pages.map(p => p.page),
      [1, 2]
    );
    assert.equal(pages[0].img, `${CDN}/file/mangap/2120/10001000/1.jpg`);
    // legacy page urls carry no ?t= expiry token — nothing downstream should assume one
    assert.doesNotMatch(pages[0].img, /[?&]t=/);
  });
});

describe('MangaPill fetchMangaInfo returns clean metadata', () => {
  test('the h1 title is primary-only and the sibling alt block lands on altTitles', async () => {
    const info = await provider().fetchMangaInfo('2120/kaguya-sama-love-is-war');
    assert.equal(info.title, 'Kaguya-sama - Love Is War');
    assert.equal(info.altTitles, KAGUYA_ALTS);
  });

  test('genres are trimmed before filtering, so no "Genres" label and no empty strings survive', async () => {
    const info = await provider().fetchMangaInfo('2120/kaguya-sama-love-is-war');
    assert.deepEqual(info.genres, ['Comedy', 'Drama', 'Slice of Life']);
  });

  test('chapters still parse', async () => {
    const info = await provider().fetchMangaInfo('2120/kaguya-sama-love-is-war');
    assert.equal(info.chapters.length, 2);
    assert.equal(info.chapters[1].id, '2120-10001000/kaguya-sama-love-is-war-chapter-1');
    assert.equal(info.chapters[1].chapter, '1');
    assert.equal(info.releaseDate, '2015');
  });
});
