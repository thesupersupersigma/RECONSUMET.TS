// WeebCentral (the provider still exported as MANGA.Mangasee123) — the four ways this rewrite can
// silently regress into looking healthy while returning garbage.
//
// BACKGROUND. `mangasee123.com` is dead. Its authoritative nameservers are ns1/ns2.parklogic.com
// and EVERY path — including deliberately bogus ones — answers HTTP 200 with the same ~4.7 KB
// ad-monetisation "Redirecting..." interstitial. Sister domain mangalife.us is parked by the same
// operator and manga4life.com no longer resolves. A naive uptime check sees 200 everywhere and
// reports the provider healthy, which is exactly how this stayed "working" long after it wasn't.
// The library moved to weebcentral.com — same cover CDN (temp.compsci88.com), same page CDNs
// (*.lowee.us, *.planeptune.us) — so the class name, classPath and default export are unchanged
// and only the implementation was rewritten.
//
// WHAT THIS PROTECTS.
//
// 1. THE 307-TO-A-200-ERROR-PAGE TRAP. This is the same failure shape as the parked domain, and
//    it is the reason this file exists. An unknown series id 307s to /404; an unknown or malformed
//    chapter id 307s to /400; and BOTH of those destination pages answer HTTP 200. With axios's
//    default redirect following, a garbage id therefore returns a perfectly healthy-looking 200
//    full of unrelated HTML, every selector yields nothing, and the caller gets an empty-but-
//    successful result. The provider sets `maxRedirects: 0` and treats any 3xx as a hard error.
//    Delete that and the first test below returns an object instead of throwing.
//
// 2. CHAPTERS MUST COME FROM /full-chapter-list. The series page embeds only the most recent
//    handful of chapters behind a "Show All Chapters" button — 9 of Goodnight Punpun's 147,
//    confirmed live. Parsing the series page alone truncates every long-running series to its last
//    few chapters and still looks like a success. The fixtures below deliberately give the series
//    page 2 chapters and the fragment 5, with DIFFERENT ids, so a regression is unambiguous.
//
// 3. TEXT BLEED FROM x-show-GATED MARKUP. WeebCentral is htmx + Alpine, so markup that a browser
//    hides is still text in the source. Two live-observed bleeds are pinned:
//      - a chapter row's wrapper <span> contains both the label and an x-show "Last Read" marker,
//        so the naive "first non-empty span" returned "Chapter 147 Last Read";
//      - a search card's mobile anchor wraps the "Official" corner ribbon AND the title in the
//        SAME <a>, so reading anchor text returned "Official Goodnight Punpun".
//    Both strings came back from the live site before the parse was narrowed.
//
// 4. PAGE IMAGES ARE READ, NEVER CONSTRUCTED. The legacy MangaSee scheme read a CDN host out of
//    `vm.CurPathName` and then built zero-padded filenames from a page COUNT, because MangaSee
//    never served a list. WeebCentral serves a real <img> list and the host varies per series —
//    Goodnight Punpun is on official.lowee.us, One Piece is on scans-hot.planeptune.us, both
//    confirmed live. There is no host to pin and no filename to construct. The test feeds a host
//    the provider has never seen to prove nothing is hard-coded.
//
// ALSO PINNED: the Cloudflare UA blocklist. Measured live on the same URL seconds apart —
// no UA -> 403, `axios/1.6.7` -> 403, `curl/8.7.1` -> 403, `Consumet/1.0` -> 200, the shared
// USER_AGENT -> 200. The axios default is refused, so the provider MUST send an explicit UA.
// (This is NOT the ComicK failure mode, where a browser-claiming UA is what trips the rule.)
//
// NOT PINNED, DELIBERATELY: an unreadable-chapter flag. mangadex.ts pre-flags `readable: false` +
// `externalUrl` because MangaDex lists chapters it does not host. WeebCentral exposes no
// equivalent state — the chapter list carries no availability field and every chapter sampled live
// returned a populated image list — so those fields are intentionally absent, and MangaAggregator
// reads their absence as "available", which matches reality. The empty-list throw is still tested.
//
// Offline: every HTTP call is served by a fake axios adapter installed on the provider's own
// client, so the real selector wiring runs with no network. Fixtures are trimmed copies of live
// weebcentral.com markup (/search/data, /series/<ULID>, /series/<ULID>/full-chapter-list,
// /chapters/<ULID>/images).
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/manga/mangasee123.js');
const WeebCentral = mod.default ?? mod;

const BASE = 'https://weebcentral.com';
const SERIES = '01J76XYA2AFH8MNBG4FRCM5JMV';

// ---------------------------------------------------------------------------------------------
// fixtures (trimmed from live markup)
// ---------------------------------------------------------------------------------------------

/**
 * A /search/data card in `display_mode=Full Display`.
 *
 * The mobile block that wraps the "Official" ribbon and the title in ONE anchor is reproduced
 * verbatim — that is the text-bleed source. Do not "simplify" it away.
 */
const searchCard = (id, slug, title) => `
<article class="bg-base-300 flex gap-4 p-4">
    <section class="w-full lg:w-[25%] xl:w-[20%]">
        <a href="${BASE}/series/${id}/${slug}">
            <article class="hidden lg:block w-full aspect-4/6 overflow-hidden">
                <picture>
                    <source srcset="https://temp.compsci88.com/cover/normal/${id}.webp" width="400" height="600" type="image/webp">
                    <img src="https://temp.compsci88.com/cover/fallback/${id}.jpg" alt="${title} cover" width="400" height="600" decoding="async">
                </picture>
            </article>
            <article class="lg:hidden relative overflow-hidden">
                <div class="absolute right-0 top-0 h-16 w-16">
                    <div class="absolute transform rotate-45 bg-orange-600 text-center text-white font-semibold py-1 right-[-55px] top-[12px] w-[170px]">Official</div>
                </div>
                <div>
                    <div class="w-full h-16 absolute bottom-0 flex flex-col items-center justify-center">
                        <div class="text-ellipsis truncate text-white text-center">${title}</div>
                    </div>
                </div>
            </article>
        </a>
    </section>
    <section class="w-full lg:w-[75%] xl:w-[80%] flex flex-col gap-2">
        <div class="flex gap-2 items-center">
            <span class="tooltip tooltip-bottom" data-tip="${title}">
                <a href="${BASE}/series/${id}/${slug}" class="line-clamp-1 link link-hover">${title}</a>
            </span>
        </div>
        <div class="opacity-70">
            <strong>Year:</strong>
            <span>2007</span>
        </div>
        <div class="opacity-70">
            <strong>Status:</strong>
            <span>Complete</span>
        </div>
        <div class="opacity-70">
            <strong>Type:</strong>
            <span>Manga</span>
        </div>
        <div>
            <strong class="opacity-70">Author(s): </strong>
            <span><a href="${BASE}/search?author=ASANO+Inio" class="link link-info link-hover">ASANO Inio</a></span>
        </div>
        <div class="opacity-70">
            <strong>Tag(s): </strong>
            <span>Drama,</span>
            <span>Psychological,</span>
            <span>Slice of Life</span>
        </div>
    </section>
</article>`;

/** the site's own "load more" control — present iff another page exists */
const loadMore = offset =>
  `<button hx-get="/search/data?limit=32&amp;offset=${offset}&amp;text=a&amp;display_mode=Full+Display" hx-target="#search-results" hx-swap="beforeend">View More Results...</button>`;

/** the no-results block: an alert with zero series links */
const noResults = `
<div role="alert" class="col-span-2 alert alert-warning">
    <span>No results found</span>
</div>`;

/**
 * A /series/<ULID>/full-chapter-list row. The nested span structure is load-bearing: the outer
 * `span.grow` is an ANCESTOR of both the label and the x-show "Last Read" marker, so its `.text()`
 * is "Chapter 147 Last Read". Only the leaf span holds the clean label.
 */
const chapterRow = (id, label, date) => `
<div class="flex items-center" x-data="{ new_chapter: checkNewChapter('${date}') }" x-show="mark_chapters == 'null'">
    <a href="/chapters/${id}" class="hover:bg-base-300 flex-1 flex items-center p-2">
        <span class="me-2">
            <img src="/static/images/chapter-badge-official.svg" alt="" width="16" height="16" class="w-4 h-4" decoding="async">
        </span>
        <span class="grow flex items-center gap-2">
            <span class="">${label}</span>
            <span class="flex gap-1 items-center link-info" x-show="last_read_chapter === '${id}'">
                <span class="hidden md:inline">Last Read</span>
            </span>
        </span>
        <time class="text-datetime opacity-50" datetime="${date}">${date.replace('Z', '343Z')}</time>
    </a>
    <input type="checkbox" value="${id}" name="chapter_id" form="mark-as-read-form" class="checkbox ms-4">
</div>`;

/** ids the series page embeds (the truncated preview) vs ids only the fragment has */
const PREVIEW_CHAPTERS = [
  ['01PREVAAAAAAAAAAAAAAAAAAA1', 'Chapter 147', '2024-09-07T17:04:15.717Z'],
  ['01PREVAAAAAAAAAAAAAAAAAAA2', 'Chapter 146', '2024-09-06T17:04:15.717Z'],
];
const FULL_CHAPTERS = [
  ['01FRAGBBBBBBBBBBBBBBBBBBB1', 'Chapter 147', '2024-09-07T17:04:15.717Z'],
  ['01FRAGBBBBBBBBBBBBBBBBBBB2', 'Chapter 146', '2024-09-06T17:04:15.717Z'],
  ['01FRAGBBBBBBBBBBBBBBBBBBB3', 'Chapter 145', '2024-09-05T17:04:15.717Z'],
  ['01FRAGBBBBBBBBBBBBBBBBBBB4', 'Chapter 2', '2024-09-04T17:04:15.717Z'],
  ['01FRAGBBBBBBBBBBBBBBBBBBB5', 'Chapter 1', '2024-09-03T17:04:15.717Z'],
];

const seriesPage = `
<meta property="og:title" content="Goodnight Punpun | Weeb Central">
<meta property="og:image" content="https://temp.compsci88.com/cover/fallback/${SERIES}.jpg">
<main class="bg-base-100 flex-1 flex flex-col items-center py-4" hx-ext="response-targets">
  <div id="top" class="bg-base-200 max-w-7xl w-full flex flex-col gap-4 p-6">
    <section class="flex flex-col md:flex-row gap-4">
      <section class="md:w-4/12 flex flex-col gap-4">
        <h1 class="md:hidden text-2xl font-bold text-center">Goodnight Punpun</h1>
        <section class="flex items-center justify-center">
          <picture>
            <source srcset="https://temp.compsci88.com/cover/normal/${SERIES}.webp" width="400" height="600" type="image/webp">
            <img src="https://temp.compsci88.com/cover/fallback/${SERIES}.jpg" alt="Goodnight Punpun cover" width="400" height="600" decoding="async">
          </picture>
        </section>
        <section>
          <ul class="flex flex-col gap-4">
            <li>
              <strong>Author(s): </strong>
              <span><a href="${BASE}/search?author=ASANO+Inio" class="link link-info link-hover">ASANO Inio</a></span>
            </li>
            <li>
              <strong>Tags(s): </strong>
              <span><a href="${BASE}/search?included_tag=Drama" class="link link-info link-hover">Drama</a>,</span>
              <span><a href="${BASE}/search?included_tag=Seinen" class="link link-info link-hover">Seinen</a></span>
            </li>
            <li>
              <strong>Type: </strong>
              <a href="${BASE}/search?included_type=Manga" class="link link-info link-hover">Manga</a>
            </li>
            <li>
              <strong>Status: </strong>
              <a href="${BASE}/search?included_status=Complete" class="link link-info link-hover">Complete</a>
            </li>
            <li>
              <strong>Released: </strong>
              <span>2007</span>
            </li>
            <li class="flex gap-4">
              <strong>Track:</strong>
              <span class="flex gap-4">
                <span class="tooltip" data-tip="AniList">
                  <a href="https://anilist.co/manga/34632" target="_blank" rel="noopener noreferrer">AniList</a>
                </span>
              </span>
            </li>
          </ul>
        </section>
      </section>
      <section class="md:w-8/12 flex flex-col gap-4">
        <h1 class="hidden md:block text-2xl font-bold">Goodnight Punpun</h1>
        <ul class="flex flex-col gap-4">
          <li>
            <strong>Description</strong>
            <p class="whitespace-pre-wrap">Meet Punpun Punyama. He's an average kid in an average town.</p>
          </li>
          <li>
            <strong>Associated Name(s)</strong>
            <ul class="list-disc list-inside">
              <li>Oyasumi Punpun</li>
              <li>おやすみプンプン</li>
            </ul>
          </li>
        </ul>
        <section x-data="{ mark_chapters: 'null' }">
          <div id="chapter-list" class="flex flex-col mt-2 divide-y divide-slate-500">
            ${PREVIEW_CHAPTERS.map(c => chapterRow(...c)).join('\n')}
          </div>
          <button hx-get="${BASE}/series/${SERIES}/full-chapter-list" hx-target="#chapter-list" hx-swap="outerHTML">Show All Chapters</button>
        </section>
      </section>
    </section>
  </div>
</main>`;

const fullChapterList = FULL_CHAPTERS.map(c => chapterRow(...c)).join('\n');

/**
 * A /chapters/<ULID>/images fragment. `host` is a parameter so a test can serve a CDN the provider
 * has never heard of; `broken_image.jpg` is the site's client-side onerror placeholder and must
 * never be reported as a page.
 */
const imagesFragment = (host, slug, chapter, pages) => `
<section id="chapter-images" class="w-full flex-1 flex flex-col pb-4 cursor-pointer"
	hx-get="${BASE}/chapters/xxx/images" hx-trigger="change from:[name='reading_style']">
${Array.from({ length: pages }, (_, i) => {
  const n = String(i + 1).padStart(3, '0');
  return `	<img
		src="https://${host}/manga/${slug}/${chapter}-${n}.png"
		class="max-w-full h-auto mx-auto"
		alt="Page ${i + 1}"
		decoding="async"
		loading="lazy"
		onerror="this.onerror=null; this.src='/static/images/broken_image.jpg'" />`;
}).join('\n')}
	<img src="/static/images/broken_image.jpg" alt="" class="hidden">
</section>`;

// ---------------------------------------------------------------------------------------------
// fake transport
// ---------------------------------------------------------------------------------------------

/**
 * axios adapter over a {url-substring -> reply} map, longest match wins.
 *
 * A reply is either a body string (=> 200) or `{ status, headers, data }`, which is how the 307
 * redirect trap is reproduced. Note that a custom adapter settles the promise itself, so the
 * provider's `validateStatus` never rejects — the provider's own explicit status check is what
 * must catch a 3xx, which is precisely the behaviour under test.
 */
const fakeAdapter = routes => {
  const seen = [];
  const adapter = async config => {
    seen.push({ url: config.url, headers: config.headers ?? {}, config });
    const hit = Object.keys(routes)
      .filter(k => config.url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (hit === undefined) throw new Error(`ECONNREFUSED ${config.url}`);
    const reply = routes[hit];
    const res = typeof reply === 'string' ? { status: 200, headers: {}, data: reply } : reply;
    return { status: 200, statusText: 'OK', headers: {}, data: '', config, ...res };
  };
  adapter.seen = seen;
  return adapter;
};

const provider = adapter => {
  const p = new WeebCentral();
  p.client.defaults.adapter = adapter;
  return p;
};

/** the happy-path route table, shared by most tests */
const happyRoutes = ({ host = 'official.lowee.us', pages = 3 } = {}) => ({
  '/search/data': `${searchCard(SERIES, 'Oyasumi-Punpun', 'Goodnight Punpun')}${loadMore(32)}`,
  [`/series/${SERIES}/full-chapter-list`]: fullChapterList,
  [`/series/${SERIES}`]: seriesPage,
  '/images': imagesFragment(host, 'Oyasumi-Punpun', '0147', pages),
});

// ---------------------------------------------------------------------------------------------

describe('the dead mangasee123.com domain is gone from the provider', () => {
  test('no request and no returned URL points at mangasee123.com or its parked siblings', async () => {
    const adapter = fakeAdapter(happyRoutes());
    const p = provider(adapter);

    const search = await p.search('punpun');
    const info = await p.fetchMangaInfo(SERIES);
    const pages = await p.fetchChapterPages(info.chapters[0].id);

    const dead = /mangasee123\.com|mangalife\.us|manga4life\.com/;
    for (const { url } of adapter.seen) assert.ok(!dead.test(url), `requested a dead domain: ${url}`);
    for (const r of search.results) assert.ok(!dead.test(String(r.image)), `dead cover host: ${r.image}`);
    for (const pg of pages) assert.ok(!dead.test(pg.img), `dead page host: ${pg.img}`);
    assert.ok(adapter.seen.every(s => s.url.startsWith(BASE)), 'every request must go to weebcentral.com');
  });

  test('the public entry point is unchanged: MANGA.Mangasee123 still resolves', () => {
    // Renaming the class or classPath would break existing callers and route tables. Only the
    // display `name` moved to WeebCentral.
    const p = new WeebCentral();
    assert.equal(p.toString.classPath, 'MANGA.Mangasee123');
    assert.equal(p.toString.baseUrl, BASE);
    assert.equal(p.name, 'WeebCentral');
  });
});

describe('a 3xx is a not-found, because WeebCentral error pages answer 200', () => {
  // The whole point: /404 and /400 return HTTP 200, so following the redirect turns a bad id into
  // a healthy-looking empty result. These must THROW.

  test('an unknown series id (307 -> /404) throws instead of returning an empty IMangaInfo', async () => {
    const p = provider(
      fakeAdapter({
        [`/series/${SERIES}`]: { status: 307, headers: { location: '/404' }, data: '' },
      })
    );
    await assert.rejects(() => p.fetchMangaInfo(SERIES), err => {
      assert.match(err.message, /redirect/i);
      assert.match(err.message, /307/);
      return true;
    });
  });

  test('an unknown chapter id (307 -> /400) throws instead of returning zero pages', async () => {
    const CH = '01FRAGBBBBBBBBBBBBBBBBBBB1';
    const p = provider(
      fakeAdapter({ '/images': { status: 307, headers: { location: '/400' }, data: '' } })
    );
    await assert.rejects(() => p.fetchChapterPages(CH), /redirect/i);
  });

  test('following the redirect would have produced a SILENT empty success — proof the guard matters', async () => {
    // Same request, but the transport already followed the 307 the way default axios would: the
    // provider now sees HTTP 200 and the body of /404. Without the status guard this is
    // indistinguishable from a real page, and it is what the caller used to get back.
    const errorPage200 = '<main><h1>404</h1><p>Page not found</p></main>';
    const p = provider(fakeAdapter({ [`/series/${SERIES}`]: errorPage200, '/full-chapter-list': errorPage200 }));
    const info = await p.fetchMangaInfo(SERIES);
    assert.equal(info.chapters.length, 0, 'a followed redirect yields a chapterless "success"');
    assert.equal(info.title, '404');
  });

  test('a 403 (the Cloudflare UA blocklist) throws and names the cause', async () => {
    const p = provider(fakeAdapter({ [`/series/${SERIES}`]: { status: 403, data: 'blocked' } }));
    await assert.rejects(() => p.fetchMangaInfo(SERIES), err => {
      assert.match(err.message, /403/);
      assert.match(err.message, /User-Agent/i);
      return true;
    });
  });
});

describe('an explicit User-Agent is sent — the axios default is 403ed', () => {
  test('every request carries a User-Agent that is not axios/curl', async () => {
    const adapter = fakeAdapter(happyRoutes());
    const p = provider(adapter);
    await p.search('punpun');
    await p.fetchMangaInfo(SERIES);
    await p.fetchChapterPages('01FRAGBBBBBBBBBBBBBBBBBBB1');

    assert.ok(adapter.seen.length >= 4);
    for (const { url, headers } of adapter.seen) {
      const ua = headers['User-Agent'] ?? headers['user-agent'];
      assert.ok(ua, `no User-Agent on ${url} — the axios default is refused with 403`);
      assert.doesNotMatch(ua, /^axios\//, `axios default UA is blocklisted (${url})`);
      assert.doesNotMatch(ua, /^curl\//, `curl UA is blocklisted (${url})`);
    }
  });
});

describe('chapters come from /full-chapter-list, not the truncated series page', () => {
  test('the full-chapter-list fragment is actually requested', async () => {
    const adapter = fakeAdapter(happyRoutes());
    await provider(adapter).fetchMangaInfo(SERIES);
    assert.ok(
      adapter.seen.some(s => s.url === `${BASE}/series/${SERIES}/full-chapter-list`),
      'the series page only embeds the last few chapters; the fragment must be fetched'
    );
  });

  test('the returned chapters are the fragment\'s, not the series page preview', async () => {
    const info = await provider(fakeAdapter(happyRoutes())).fetchMangaInfo(SERIES);
    assert.equal(info.chapters.length, FULL_CHAPTERS.length);
    assert.deepEqual(
      info.chapters.map(c => c.id),
      FULL_CHAPTERS.map(c => c[0])
    );
    // the preview ids must not leak in — that is the truncation regression
    for (const [id] of PREVIEW_CHAPTERS)
      assert.ok(!info.chapters.some(c => c.id === id), `series-page preview chapter ${id} leaked in`);
  });

  test('chapter titles are the leaf label, with no x-show "Last Read" bleed', async () => {
    const info = await provider(fakeAdapter(happyRoutes())).fetchMangaInfo(SERIES);
    assert.deepEqual(
      info.chapters.map(c => c.title),
      ['Chapter 147', 'Chapter 146', 'Chapter 145', 'Chapter 2', 'Chapter 1']
    );
    for (const c of info.chapters) assert.doesNotMatch(c.title, /Last Read/);
  });

  test('releaseDate uses the clean ISO datetime attribute, not the raw element text', async () => {
    const info = await provider(fakeAdapter(happyRoutes())).fetchMangaInfo(SERIES);
    assert.equal(info.chapters[0].releaseDate, '2024-09-07T17:04:15.717Z');
    assert.doesNotMatch(info.chapters[0].releaseDate, /343Z$/); // the microsecond DB value
  });
});

describe('series metadata is read by label, not by Tailwind class', () => {
  test('every field parses off the live markup shape', async () => {
    const info = await provider(fakeAdapter(happyRoutes())).fetchMangaInfo(SERIES);
    assert.equal(info.id, SERIES);
    assert.equal(info.title, 'Goodnight Punpun');
    assert.deepEqual(info.altTitles, ['Oyasumi Punpun', 'おやすみプンプン']);
    assert.deepEqual(info.authors, ['ASANO Inio']);
    // the series page spells it "Tags(s):" and the search card "Tag(s):" — prefix match covers both
    assert.deepEqual(info.genres, ['Drama', 'Seinen']);
    assert.equal(info.status, 'Completed'); // WeebCentral says "Complete"
    assert.equal(info.releaseDate, '2007');
    assert.match(String(info.description), /^Meet Punpun Punyama/);
    assert.ok(info.links.includes('https://anilist.co/manga/34632'));
    assert.equal(info.headerForImage.Referer, `${BASE}/`);
  });

  test('a series URL or <ULID>/<Slug> is accepted and normalised to the bare ULID', async () => {
    for (const form of [SERIES, `${SERIES}/Oyasumi-Punpun`, `${BASE}/series/${SERIES}/Oyasumi-Punpun`]) {
      const adapter = fakeAdapter(happyRoutes());
      const info = await provider(adapter).fetchMangaInfo(form);
      assert.equal(info.id, SERIES, `id not normalised for ${form}`);
      // the slug is decorative — /series/<ULID> serves the identical page
      assert.ok(adapter.seen.some(s => s.url === `${BASE}/series/${SERIES}`));
    }
  });

  test('a legacy mangasee123 slug id is rejected with an actionable message', async () => {
    // The old provider's ids looked like "Yofukashi-no-Uta" and "Yofukashi-no-Uta-chapter-1".
    // Those do not exist on WeebCentral, and failing loudly beats a mystery empty result.
    const p = provider(fakeAdapter(happyRoutes()));
    await assert.rejects(() => p.fetchMangaInfo('Yofukashi-no-Uta'), /ULID/);
    await assert.rejects(() => p.fetchChapterPages('Yofukashi-no-Uta-chapter-1'), /ULID/);
  });
});

describe('search reads the htmx /search/data endpoint', () => {
  test('the title is the cover alt, with no "Official" ribbon bleed', async () => {
    const { results } = await provider(fakeAdapter(happyRoutes())).search('punpun');
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Goodnight Punpun');
    assert.doesNotMatch(results[0].title, /Official/);
  });

  test('a card yields the ULID once, plus its metadata', async () => {
    const { results } = await provider(fakeAdapter(happyRoutes())).search('punpun');
    const r = results[0];
    assert.equal(r.id, SERIES); // deduped: the card links the same series four times
    assert.equal(r.image, `https://temp.compsci88.com/cover/normal/${SERIES}.webp`);
    assert.equal(r.status, 'Completed');
    assert.equal(r.releaseDate, '2007');
    assert.deepEqual(r.authors, ['ASANO Inio']);
    assert.deepEqual(r.genres, ['Drama', 'Psychological', 'Slice of Life']);
  });

  test('paging is offset-based and the page size is NOT caller-settable', async () => {
    // The server ignores `limit` and always returns 32 (measured live for limit=5..200), so a
    // caller-supplied limit would produce overlapping pages. Offset must step by 32.
    const adapter = fakeAdapter(happyRoutes());
    await provider(adapter).search('a', 3);
    const url = adapter.seen.find(s => s.url.includes('/search/data')).url;
    assert.match(url, /offset=64/);
    assert.match(url, /limit=32/);
    assert.match(url, /display_mode=Full\+Display/); // grid mode would drop all the metadata
  });

  test('hasNextPage comes from the site\'s own load-more control', async () => {
    const withMore = await provider(fakeAdapter(happyRoutes())).search('a');
    assert.equal(withMore.hasNextPage, true);

    const lastPage = await provider(
      fakeAdapter({ '/search/data': searchCard(SERIES, 'Oyasumi-Punpun', 'Goodnight Punpun') })
    ).search('punpun');
    assert.equal(lastPage.hasNextPage, false, 'no load-more control means no next page');
  });

  test('a no-results query returns [] rather than throwing or inventing a row', async () => {
    const res = await provider(fakeAdapter({ '/search/data': noResults })).search('zzzzqqqq');
    assert.deepEqual(res.results, []);
    assert.equal(res.hasNextPage, false);
  });

  test('page 0 is rejected', async () => {
    await assert.rejects(() => provider(fakeAdapter(happyRoutes())).search('a', 0), /Page number/);
  });
});

describe('page images are read from the served list, never constructed', () => {
  test('a CDN host the provider has never seen is used verbatim', async () => {
    // Live, the host varies per series: official.lowee.us vs scans-hot.planeptune.us. Anything
    // pinned or rebuilt from a page count fails here.
    const host = 'brand-new-cdn.example';
    const p = provider(fakeAdapter(happyRoutes({ host, pages: 4 })));
    const pages = await p.fetchChapterPages('01FRAGBBBBBBBBBBBBBBBBBBB1');

    assert.equal(pages.length, 4);
    assert.ok(pages.every(pg => new URL(pg.img).host === host));
    assert.deepEqual(
      pages.map(pg => pg.page),
      [1, 2, 3, 4]
    );
    assert.equal(pages[0].img, `https://${host}/manga/Oyasumi-Punpun/0147-001.png`);
    assert.equal(pages[0].headerForImage.Referer, `${BASE}/`);
  });

  test('the onerror placeholder is never reported as a page', async () => {
    const pages = await provider(fakeAdapter(happyRoutes({ pages: 2 }))).fetchChapterPages(
      '01FRAGBBBBBBBBBBBBBBBBBBB1'
    );
    assert.equal(pages.length, 2, 'broken_image.jpg must not be counted');
    for (const pg of pages) assert.doesNotMatch(pg.img, /broken_image|\/static\/images\//);
  });

  test('an empty image list throws rather than reporting an empty success', async () => {
    // WeebCentral has no mangadex-style `externalUrl` / `readable: false` state to pre-flag, so
    // this throw is the only place an unreadable chapter can surface.
    const p = provider(fakeAdapter({ '/images': '<section id="chapter-images"></section>' }));
    await assert.rejects(() => p.fetchChapterPages('01FRAGBBBBBBBBBBBBBBBBBBB1'), /no page images/i);
  });

  test('the reader query parameters the site sends are reproduced', async () => {
    const adapter = fakeAdapter(happyRoutes());
    await provider(adapter).fetchChapterPages('01FRAGBBBBBBBBBBBBBBBBBBB1');
    const url = adapter.seen.find(s => s.url.includes('/images')).url;
    assert.match(url, /is_prev=False/);
    assert.match(url, /current_page=1/);
    assert.match(url, /reading_style=long_strip/);
  });
});
