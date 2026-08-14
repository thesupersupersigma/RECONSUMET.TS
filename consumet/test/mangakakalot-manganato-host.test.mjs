// MangaKakalot after the move to www.manganato.gg.
//
// WHAT THIS PROTECTS. This provider had TWO hardcoded hosts and both died: `mangakakalot.com` now
// 301s every real path to a wheel-spinner site, and `readmanganato.com` is domain-parked. Which
// host was used got decided by a `$$READMANGANATO` sentinel smuggled through the chapter-id field.
// The whole thing was rewritten against `www.manganato.gg` — the one mirror in this family that is
// not behind a Cloudflare challenge.
//
// Every assertion here corresponds to something that was actually wrong, or to a detail that is
// invisible until it silently breaks in production:
//
//   1. Dead hosts. Nothing may address mangakakalot.com / readmanganato.com ever again.
//   2. Chapter lists are NOT in the detail page any more — it ships an empty
//      `#chapter-list-container` and lazy-loads `/api/manga/<slug>/chapters`, which is paginated.
//      Scraping the page returns zero chapters, so the JSON path and its `has_more` loop are pinned.
//   3. Chapter ids are `<slug>/<chapter-slug>`. No magic sentinel, and the pages URL is
//      `/manga/<slug>/<chapter>`, not the old `/chapter/<id>`.
//   4. THE IMAGE Referer NEEDS ITS TRAILING SLASH. Verified live: `https://www.manganato.gg/` gets
//      289,722 bytes of image/webp, while the bare origin `https://www.manganato.gg` and the real
//      chapter URL both get 403 + Cloudflare HTML. "Simplifying" this to `baseUrl` breaks every
//      cover and every page image while the JSON still looks perfect.
//   5. `Author(s)` was being interpolated into a RegExp, where `(s)` is a capture group, so the
//      label never matched and EVERY manga came back with no authors.
//   6. An id given as a full URL used to normalise to the literal slug `manga`.
//   7. Search must never call `/search/story/` — it is 403 to every non-browser client and
//      robots.txt disallows it. Search is served from the robots-advertised sitemap instead. If a
//      future edit "fixes" search by pointing it back at the blocked endpoint, this goes red.
//
// Offline: every HTTP call is served by a fake axios adapter, so the real provider wiring is
// exercised with no network.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/manga/mangakakalot.js');
const MangaKakalot = mod.default ?? mod;

const ORIGIN = 'https://www.manganato.gg';

// ------------------------------------------------------------------------------------------------
// fixtures
// ------------------------------------------------------------------------------------------------

/**
 * The detail page, in the shape the live site actually serves: the chapter list is NOT here, only
 * an empty container carrying the API url and the chapter url template.
 */
const DETAIL_HTML = `<html><body>
  <div class="manga-info-top">
    <div class="manga-info-pic">
      <img src="https://img-r2.2xstorage.com/thumb/test-manga.webp" alt="Test Manga" />
    </div>
    <div class="manga-info-content">
      <ul class="manga-info-text">
        <li><h1>Test Manga</h1></li>
        <li>Author(s) : Alpha Author, Beta Author</li>
        <li>Status : Completed</li>
        <li>Last updated : Aug-07-2026 10:14:35 AM</li>
        <li style="display: none;">TransGroup : </li>
        <li>View : 1,234,567</li>
        <li class="genres">Genres :
          <a href="${ORIGIN}/genre/action">Action</a>,
          <a href="${ORIGIN}/genre/comedy">Comedy</a>
        </li>
        <li><span>Rating : </span><div class="rating" data-default="4.90"></div></li>
      </ul>
    </div>
  </div>
  <div id="chapter" class="chapter">
    <div id="chapter-list-container" class="chapter-list-loading"
         data-comic-slug="test-manga"
         data-api-url="${ORIGIN}/api/manga/__SLUG__/chapters"
         data-chapter-url-template="${ORIGIN}/manga/__MANGA__/__CHAPTER__">
      <p class="chapter-loading-text">Loading chapters...</p>
    </div>
  </div>
  <div id="contentBox">
    <h2><p style="color: red;">Test Manga summary: </p></h2>
    A hero &amp;quot;quoted&amp;quot; here.&lt;br&gt;
    &lt;br&gt;
    &lt;b&gt;Bold note&lt;/b&gt;
  </div>
</body></html>`;

/** First page of the chapter API: two chapters and `has_more: true`. */
const CHAPTERS_PAGE_1 = {
  success: true,
  data: {
    chapters: [
      { chapter_name: 'Chapter 3: Third', chapter_slug: 'chapter-3', chapter_num: 3, updated_at: '2026-08-07T10:14:35.000000Z', view: 300 },
      { chapter_name: 'Chapter 2', chapter_slug: 'chapter-2', chapter_num: 2, updated_at: '2026-08-06T10:14:35.000000Z', view: 200 },
    ],
    pagination: { total: 3, limit: 500, offset: 0, has_more: true },
  },
};

/** Second page. Reached only if the provider advances the offset by the batch it actually got. */
const CHAPTERS_PAGE_2 = {
  success: true,
  data: {
    chapters: [
      { chapter_name: 'Chapter 1', chapter_slug: 'chapter-1', chapter_num: 1, updated_at: '2026-08-05T10:14:35.000000Z', view: 100 },
    ],
    pagination: { total: 3, limit: 500, offset: 2, has_more: false },
  },
};

const CHAPTER_HTML = `<html><body>
  <div class="container-chapter-reader">
    <img src="https://img-r1.2xstorage.com/test-manga/3/0.webp"
         alt="Test Manga Chapter 3: Third page 1 - MangaNato">
    <img src="https://img-r1.2xstorage.com/test-manga/3/1.webp"
         alt="Test Manga Chapter 3: Third page 2 - MangaNato">
  </div>
</body></html>`;

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex>
  <sitemap><loc>${ORIGIN}/sitemap0.xml</loc></sitemap>
  <sitemap><loc>${ORIGIN}/sitemap-comic-1.xml</loc></sitemap>
  <sitemap><loc>${ORIGIN}/sitemap-comic-2.xml</loc></sitemap>
</sitemapindex>`;

/** A non-comic shard. It must be tolerated and contribute nothing. */
const SITEMAP_0 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset><url><loc>${ORIGIN}/manga-list/latest-manga</loc></url></urlset>`;

const urlset = slugs =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${slugs
    .map(s => `  <url><loc>${ORIGIN}/manga/${s}</loc><lastmod>2026-08-14T01:28:11+00:00</lastmod></url>`)
    .join('\n')}\n</urlset>`;

// Shards are ordered most-recently-updated first, and that order is the tiebreaker in ranking.
const SITEMAP_1 = urlset(['unrelated-series', 'test-manga-side-story', 'test-manga', 'a-test-of-manga']);
const SITEMAP_2 = urlset(['test-manga-alpha', 'test-manga', 'something-else']); // note: duplicate slug

const LISTING_HTML = `<html><body>
  <div class="list-comic-item-wrap" id="js-banner-ai-list-ad" hidden>
    <a class="list-story-item cover js-banner-ai-list-link" href="#" title=""><img alt="" class="lazy"></a>
    <h3><a class="js-banner-ai-list-title-link" href="#" title=""><span></span></a></h3>
  </div>
  <div class="list-comic-item-wrap">
    <a data-id="1" class="list-story-item bookmark_check cover" href="${ORIGIN}/manga/browse-only-manga" title="Browse Only Manga">
      <img alt="Browse Only Manga" class="lazy" data-src="https://img-r1.2xstorage.com/thumb/browse-only-manga.webp">
    </a>
    <h3><a href="${ORIGIN}/manga/browse-only-manga" title="Browse Only Manga">Browse Only Manga</a></h3>
  </div>
  <div class="list-comic-item-wrap">
    <a data-id="2" class="list-story-item bookmark_check cover" href="${ORIGIN}/manga/other-thing" title="Other Thing">
      <img alt="Other Thing" class="lazy" data-src="https://img-r1.2xstorage.com/thumb/other-thing.webp">
    </a>
    <h3><a href="${ORIGIN}/manga/other-thing" title="Other Thing">Other Thing</a></h3>
  </div>
</body></html>`;

const ROUTES = {
  [`${ORIGIN}/manga/test-manga`]: DETAIL_HTML,
  [`${ORIGIN}/manga/test-manga/chapter-3`]: CHAPTER_HTML,
  [`${ORIGIN}/api/manga/test-manga/chapters?limit=500&offset=0`]: CHAPTERS_PAGE_1,
  [`${ORIGIN}/api/manga/test-manga/chapters?limit=500&offset=2`]: CHAPTERS_PAGE_2,
  [`${ORIGIN}/sitemap.xml`]: SITEMAP_INDEX,
  [`${ORIGIN}/sitemap0.xml`]: SITEMAP_0,
  [`${ORIGIN}/sitemap-comic-1.xml`]: SITEMAP_1,
  [`${ORIGIN}/sitemap-comic-2.xml`]: SITEMAP_2,
  [`${ORIGIN}/manga-list/latest-manga`]: LISTING_HTML,
  [`${ORIGIN}/manga-list/hot-manga`]: LISTING_HTML,
  [`${ORIGIN}/manga-list/new-manga`]: LISTING_HTML,
};

// ------------------------------------------------------------------------------------------------
// fake transport
// ------------------------------------------------------------------------------------------------

/**
 * axios adapter over an exact {url → body} map. `seen` records every request so tests can assert
 * what was and was NOT fetched. Unknown `/manga/<slug>` urls resolve as 404 (the site's real answer
 * for a slug that does not exist, which the search fallback probes for); anything else rejects, the
 * way a dead host behaves.
 */
const fakeAdapter = (routes = ROUTES, { fail = () => false } = {}) => {
  const seen = [];
  const adapter = async config => {
    const url = String(config.url);
    seen.push(url);
    if (fail(url)) throw new Error(`blocked by test: ${url}`);
    if (Object.prototype.hasOwnProperty.call(routes, url))
      return { data: routes[url], status: 200, statusText: 'OK', headers: {}, config };
    if (url.startsWith(`${ORIGIN}/manga/`))
      return { data: '<html><body>404</body></html>', status: 404, statusText: 'Not Found', headers: {}, config };
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

// ------------------------------------------------------------------------------------------------

describe('MangaKakalot talks to manganato.gg and nothing else', () => {
  test('the dead hosts are never addressed, on any code path', async () => {
    const adapter = fakeAdapter();
    const p = provider(adapter);
    await p.fetchMangaInfo('test-manga');
    await p.fetchChapterPages('test-manga/chapter-3');
    await p.search('test manga');

    assert.ok(adapter.seen.length > 0, 'no requests were made at all');
    for (const url of adapter.seen) {
      assert.doesNotMatch(url, /mangakakalot\.com/, `dead host mangakakalot.com: ${url}`);
      assert.doesNotMatch(url, /readmanganato\.com/, `parked host readmanganato.com: ${url}`);
      assert.match(url, /^https:\/\/www\.manganato\.gg\//, `off-host request: ${url}`);
    }
  });

  test('no request claims to be a browser', async () => {
    // This family's edge rule challenges a browser-claiming UA from a non-browser TLS stack, so a
    // `Mozilla/5.0` here would turn 200s into 403s. Pinned so nobody "helpfully" adds one.
    const seenHeaders = [];
    const adapter = async config => {
      seenHeaders.push(config.headers ?? {});
      return { data: DETAIL_HTML, status: 200, statusText: 'OK', headers: {}, config };
    };
    const p = provider(adapter);
    await p.fetchMangaInfo('test-manga').catch(() => {});
    for (const h of seenHeaders) {
      const ua = h['User-Agent'] ?? h['user-agent'] ?? '';
      assert.doesNotMatch(String(ua), /Mozilla/i, `provider sent a browser UA: ${ua}`);
    }
  });
});

describe('fetchMangaInfo parses the current detail page', () => {
  test('scalar fields come back, including the authors that the RegExp bug ate', async () => {
    const info = await provider(fakeAdapter()).fetchMangaInfo('test-manga');

    assert.equal(info.id, 'test-manga');
    assert.equal(info.title, 'Test Manga');
    assert.equal(info.image, 'https://img-r2.2xstorage.com/thumb/test-manga.webp');
    assert.equal(info.status, 'Completed');
    assert.equal(info.views, 1234567);
    assert.equal(info.rating, 4.9);
    assert.equal(info.updatedAt, 'Aug-07-2026 10:14:35 AM');
    assert.deepEqual(info.genres, ['Action', 'Comedy']);

    // `Author(s)` used to be interpolated into a RegExp, where `(s)` is a group — so this was
    // undefined for every manga on the site.
    assert.deepEqual(info.authors, ['Alpha Author', 'Beta Author']);
  });

  test('the double-escaped synopsis is unescaped, de-tagged and de-headed', async () => {
    const info = await provider(fakeAdapter()).fetchMangaInfo('test-manga');
    assert.match(info.description, /A hero "quoted" here\./, `bad description: ${info.description}`);
    assert.doesNotMatch(info.description, /&quot;|&amp;|&lt;|&gt;/, 'entities survived');
    assert.doesNotMatch(info.description, /<br>|<b>|<\/b>/, 'literal pseudo-tags survived');
    assert.doesNotMatch(info.description, /summary\s*:/i, 'the summary heading survived');
    assert.match(info.description, /Bold note/, 'tag stripping ate the text inside the tags');
  });

  test('an id given as a full URL resolves to the slug, not to "manga"', async () => {
    // `.split('/manga/')` on an already-host-stripped path used to yield the literal slug `manga`.
    const p = provider(fakeAdapter());
    for (const form of ['test-manga', 'manga/test-manga', `${ORIGIN}/manga/test-manga`, '/manga/test-manga']) {
      const info = await p.fetchMangaInfo(form);
      assert.equal(info.id, 'test-manga', `id form ${JSON.stringify(form)} normalised wrong`);
    }
  });
});

describe('chapters come from the lazy-loaded JSON API', () => {
  test('the paginated API is followed to the end, and the page is NOT scraped for chapters', async () => {
    const adapter = fakeAdapter();
    const info = await provider(adapter).fetchMangaInfo('test-manga');

    // The live detail page carries no chapter rows at all — if this ever reads 0, the provider has
    // silently gone back to scraping an element that is empty by design.
    assert.equal(info.chapters.length, 3, 'chapter API pagination was not followed');
    assert.deepEqual(
      info.chapters.map(c => c.id),
      ['test-manga/chapter-3', 'test-manga/chapter-2', 'test-manga/chapter-1']
    );

    // Both API pages really were requested, and the offset advanced by the batch actually received.
    assert.ok(
      adapter.seen.includes(`${ORIGIN}/api/manga/test-manga/chapters?limit=500&offset=0`),
      `first chapter page not requested: ${adapter.seen.join(', ')}`
    );
    assert.ok(
      adapter.seen.includes(`${ORIGIN}/api/manga/test-manga/chapters?limit=500&offset=2`),
      `second chapter page not requested: ${adapter.seen.join(', ')}`
    );
  });

  test('a chapter id is "<slug>/<chapter-slug>" with no in-band sentinel', async () => {
    const info = await provider(fakeAdapter()).fetchMangaInfo('test-manga');
    for (const c of info.chapters) {
      assert.doesNotMatch(c.id, /\$\$READMANGANATO/, `sentinel is back in an id: ${c.id}`);
      assert.match(c.id, /^test-manga\/chapter-\d+$/, `unexpected chapter id shape: ${c.id}`);
    }
    assert.equal(info.chapters[0].title, 'Chapter 3: Third');
    assert.equal(info.chapters[0].chapterNumber, 3);
    assert.equal(info.chapters[0].views, 300);
    assert.equal(info.chapters[0].url, `${ORIGIN}/manga/test-manga/chapter-3`);
  });
});

describe('fetchChapterPages', () => {
  test('reads the reader images from /manga/<slug>/<chapter>', async () => {
    const adapter = fakeAdapter();
    const pages = await provider(adapter).fetchChapterPages('test-manga/chapter-3');

    assert.equal(pages.length, 2);
    assert.equal(pages[0].img, 'https://img-r1.2xstorage.com/test-manga/3/0.webp');
    assert.equal(pages[0].page, 0);
    assert.equal(pages[1].page, 1);

    // the old shape was `${baseUrl}/chapter/${chapterId}` — it 404s on this host
    assert.ok(
      adapter.seen.includes(`${ORIGIN}/manga/test-manga/chapter-3`),
      `wrong chapter url requested: ${adapter.seen.join(', ')}`
    );
    for (const url of adapter.seen) assert.doesNotMatch(url, /\/chapter\/[^/]+$/, `old /chapter/<id> url: ${url}`);
  });

  test('the site name is stripped from the page title', async () => {
    const pages = await provider(fakeAdapter()).fetchChapterPages('test-manga/chapter-3');
    assert.equal(pages[0].title, 'Test Manga Chapter 3: Third page 1');
    for (const pg of pages) assert.doesNotMatch(pg.title, /MangaNato|MangaKakalot/i, `site name left in: ${pg.title}`);
  });

  test('the image Referer keeps its trailing slash — the CDN 403s without it', async () => {
    // Verified live on a real page image:
    //   `${ORIGIN}/`  -> 200, 289,722 bytes image/webp
    //   `${ORIGIN}`   -> 403, 4,573 bytes of Cloudflare HTML
    //   the chapter page url -> 403
    // Collapsing this back to `baseUrl` breaks every image while the JSON still looks correct.
    const p = provider(fakeAdapter());
    const pages = await p.fetchChapterPages('test-manga/chapter-3');
    const info = await p.fetchMangaInfo('test-manga');

    for (const pg of pages)
      assert.equal(pg.headerForImage.Referer, `${ORIGIN}/`, 'page image Referer lost its trailing slash');
    assert.equal(info.headerForImage.Referer, `${ORIGIN}/`, 'cover Referer lost its trailing slash');
  });

  test('ids that cannot address the new host fail loudly instead of fetching the wrong page', async () => {
    const p = provider(fakeAdapter());
    for (const bad of ['chapter-1190', '', '   ']) {
      await assert.rejects(
        p.fetchChapterPages(bad),
        err => {
          assert.match(err.message, /not a usable chapter id/i, `unhelpful message: ${err.message}`);
          assert.match(err.message, /<manga-slug>\/<chapter-slug>/, 'error must state the new id shape');
          return true;
        },
        `expected ${JSON.stringify(bad)} to be rejected`
      );
    }
  });
});

describe('search is served from the sitemap, never from the blocked /search/story/ endpoint', () => {
  test('the blocked endpoint is never requested, and the sitemap is', async () => {
    const adapter = fakeAdapter();
    await provider(adapter).search('test manga');

    for (const url of adapter.seen)
      assert.doesNotMatch(url, /\/search\/story\//, `search hit the 403/robots-disallowed endpoint: ${url}`);
    assert.ok(adapter.seen.includes(`${ORIGIN}/sitemap.xml`), 'the sitemap index was not read');
    assert.ok(adapter.seen.includes(`${ORIGIN}/sitemap-comic-1.xml`), 'a comic shard was not read');
    assert.ok(adapter.seen.includes(`${ORIGIN}/sitemap-comic-2.xml`), 'a comic shard was not read');
  });

  test('an exact slug ranks first and is enriched from its real detail page', async () => {
    const res = await provider(fakeAdapter()).search('test manga');

    assert.equal(res.results[0].id, 'test-manga', `exact match did not rank first: ${res.results[0].id}`);
    // enriched: a real title and a real cover, not a de-slugified guess
    assert.equal(res.results[0].title, 'Test Manga');
    assert.equal(res.results[0].image, 'https://img-r2.2xstorage.com/thumb/test-manga.webp');
    assert.ok(!res.results[0].approximateTitle, 'the enriched top hit must not be flagged approximate');
  });

  test('non-exact hits are de-slugified and honestly flagged as approximate', async () => {
    const res = await provider(fakeAdapter()).search('test manga');
    const side = res.results.find(r => r.id === 'test-manga-side-story');
    assert.ok(side, `expected test-manga-side-story in ${res.results.map(r => r.id).join(', ')}`);
    assert.equal(side.title, 'Test Manga Side Story');
    assert.equal(side.approximateTitle, true, 'a title derived from a slug must say so');
  });

  test('shard order breaks ties, and a slug repeated across shards appears once', async () => {
    const res = await provider(fakeAdapter()).search('test manga');
    const ids = res.results.map(r => r.id);

    assert.equal(new Set(ids).size, ids.length, `duplicate slugs in results: ${ids.join(', ')}`);
    // both score as `startsWith("test-manga-")`; shard 1 is the more recently updated shard
    assert.ok(
      ids.indexOf('test-manga-side-story') < ids.indexOf('test-manga-alpha'),
      `shard order was not preserved: ${ids.join(', ')}`
    );
    // a token match, ranked below the prefix matches
    assert.ok(ids.includes('a-test-of-manga'), `token match missing: ${ids.join(', ')}`);
    assert.ok(!ids.includes('unrelated-series'), `non-match leaked in: ${ids.join(', ')}`);
  });

  test('the index is built once and then reused', async () => {
    const adapter = fakeAdapter();
    const p = provider(adapter);
    await p.search('test manga');
    const afterFirst = adapter.seen.filter(u => u.includes('sitemap')).length;
    await p.search('test manga');
    const afterSecond = adapter.seen.filter(u => u.includes('sitemap')).length;

    assert.equal(afterFirst, 4, `expected index + 3 shards, got ${afterFirst}`);
    assert.equal(afterSecond, afterFirst, 'the sitemap was re-fetched instead of using the cache');
  });

  test('concurrent cold searches share one index build', async () => {
    const adapter = fakeAdapter();
    const p = provider(adapter);
    await Promise.all([p.search('test manga'), p.search('test manga'), p.search('test manga')]);
    assert.equal(
      adapter.seen.filter(u => u === `${ORIGIN}/sitemap.xml`).length,
      1,
      'each concurrent search built its own index'
    );
  });

  test('paging slices the ranked list without overlap', async () => {
    const p = provider(fakeAdapter());
    const page1 = await p.search('test manga', 1);
    assert.equal(page1.currentPage, 1);
    assert.equal(page1.totalResults, page1.results.length);
    assert.equal(page1.hasNextPage, false);

    const page2 = await p.search('test manga', 2);
    assert.equal(page2.currentPage, 2);
    assert.equal(page2.results.length, 0, 'page 2 of a single-page result set must be empty');
  });

  test('an empty query short-circuits without touching the network', async () => {
    const adapter = fakeAdapter();
    const res = await provider(adapter).search('   ');
    assert.deepEqual(res.results, []);
    assert.equal(res.totalResults, 0);
    assert.equal(adapter.seen.length, 0, `empty query made requests: ${adapter.seen.join(', ')}`);
  });
});

describe('search degrades instead of dying when the sitemap is unavailable', () => {
  const noSitemap = () => fakeAdapter(ROUTES, { fail: url => url.includes('sitemap') });

  test('an exact slug still resolves via a direct /manga/<slug> probe', async () => {
    const adapter = noSitemap();
    const res = await provider(adapter).search('test manga');

    assert.equal(res.results[0].id, 'test-manga');
    assert.equal(res.results[0].title, 'Test Manga', 'the fallback must read the real title, not derive one');
    assert.ok(adapter.seen.includes(`${ORIGIN}/manga/test-manga`), 'the direct slug probe did not run');
  });

  test('the browse listings supply results the slug probe cannot', async () => {
    const res = await provider(noSitemap()).search('browse only');
    const hit = res.results.find(r => r.id === 'browse-only-manga');
    assert.ok(hit, `listing scan found nothing: ${res.results.map(r => r.id).join(', ')}`);
    assert.equal(hit.title, 'Browse Only Manga');
    assert.equal(hit.image, 'https://img-r1.2xstorage.com/thumb/browse-only-manga.webp');
  });

  test('the hidden advertising card in the listings is not returned as a manga', async () => {
    const res = await provider(noSitemap()).search('browse only');
    for (const r of res.results) {
      assert.ok(r.id && r.id !== '#', `ad card leaked into results: ${JSON.stringify(r)}`);
      assert.ok(r.title, `result with no title: ${JSON.stringify(r)}`);
    }
  });

  test('a total miss returns an empty result set rather than throwing', async () => {
    const res = await provider(noSitemap()).search('nothing matches this at all');
    assert.deepEqual(res.results, []);
    assert.equal(res.totalResults, 0);
  });
});
