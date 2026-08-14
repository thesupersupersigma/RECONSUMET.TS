// VyvyManga — the renamed host, and three silent-wrong-answer parsers behind it.
//
// WHAT THIS PROTECTS.
//
// 1. THE HOST. `vyvymanga.net` is dead at the origin (Cloudflare 522 on the apex, on www, on http,
//    on both the HTML and the /api paths). The service was renamed, not shut down: `mangavyvy.net`
//    runs the same application with the same JSON contract and the same markup. Every request this
//    provider makes must go there. The fake transport below rejects anything it does not recognise,
//    so reverting the host literals makes every test in the file fail with the offending URL named.
//
// 2. THE INFO BLOCK WAS READ BY POSITION. `div.col-md-7 > p` is a VARIABLE-LENGTH list of labelled
//    paragraphs — Authors, sometimes Artists, Status, Genres. Titles that credit an artist carry the
//    extra "Artists" row, which shunts everything after it down one slot. The old code took `p[1]`
//    for status and `p[2]` for genres, so on those titles it read the Artists row for status and the
//    Status row for genres, found nothing in either, and returned an EMPTY status and an EMPTY genre
//    list. Verified live against mangavyvy.net before the fix: manga 55 (One Piece, has an Artists
//    row) returned status "" and 0 genres, while 841 (Naruto) and 97484 returned correct values.
//    Per-title, silent, and invisible to any happy-path test — hence the two fixtures here, one of
//    each shape. Lookups are label-driven now.
//
// 3. THE SEARCH CARD MOVED ITS COVER URL. The manga id is parsed out of the cover URL
//    (`/web/cover/<id>/thumbnail.png`). That URL used to sit on the wrapper div as
//    `data-background-image`; it now sits on a lazy `<img data-src>` inside it. The old code did
//    `attr('data-background-image').split('cover/')` — `.split` on `undefined` — so search() did not
//    degrade, it threw, and the whole provider's search was dead.
//
// 4. PAGINATION WAS READ BY POSITION TOO. The old code took the second-to-last <li> and pulled its
//    <a>. On the LAST page that <li> is the *active* one, which Laravel renders as a <span> with no
//    <a> — so totalPages came back NaN and hasNextPage came back true, forever, on every last page.
//
// 5. `.slice(0, -5)` ON PAGE URLS. Not rot: it strips `=w700`, the Google/Blogspot size cap, and
//    dropping it really does yield the full-resolution original (One Piece ch.1 page 1 measured
//    live: 205,876 bytes stripped vs 122,137 bytes at =w700, both valid JPEG). But it is a blind
//    5-character chop, so a URL without the suffix loses five real characters and a `=w1200` cap
//    leaves a stray `=`. It is an anchored pattern now.
//
// Offline: every HTTP call is served by a fake axios adapter installed on the provider's own client,
// so the real provider wiring is exercised with no network. Live checking is what the ts-node probes
// are for; this suite must never need the network.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/manga/vyvymanga.js');
const VyvyManga = mod.default ?? mod;

const HOST = 'https://mangavyvy.net';
const DEAD_HOST = 'vyvymanga.net';

/**
 * axios adapter over a {url-substring → body} map. Anything unmatched rejects, the way a dead or
 * renamed host actually behaves. `seen` records every request so tests can assert where it went.
 */
const fakeAdapter = routes => {
  const seen = [];
  const adapter = async config => {
    const qs = config.params ? `?${new URLSearchParams(config.params)}` : '';
    const url = `${config.url}${qs}`;
    seen.push(url);
    const hit = Object.keys(routes)
      .filter(k => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (hit === undefined) throw new Error(`ECONNREFUSED ${url}`);
    return { data: routes[hit], status: 200, statusText: 'OK', headers: {}, config };
  };
  adapter.seen = seen;
  return adapter;
};

const provider = adapter => {
  const p = new VyvyManga();
  p.client.defaults.adapter = adapter;
  return p;
};

// ---------------------------------------------------------------------------------------------
// fixtures — trimmed copies of the real mangavyvy.net markup
// ---------------------------------------------------------------------------------------------

/** `/api/manga-detail/<id>` for a title that DOES credit an artist — the shape that used to break. */
const DETAIL_WITH_ARTISTS = `<html><body>
<img class="img-manga" src="https://cdnxyz.xyz/web/cover/55/thumbnail.png" title="One Piece" alt="One Piece">
<div class="col-md-7">
  <hr>
  <p><span class="pre-title">Authors</span><span class="space">:</span> <a href="/author/oda-eiichiro">Oda, Eiichiro</a> </p>
  <p><span class="pre-title">Artists</span><span class="space">:</span> <a href="/author/oda-eiichiro">Oda, Eiichiro</a> </p>
  <p><span class="pre-title">Status</span><span class="space">:</span><span class="text-ongoing">Ongoing</span></p>
  <p><span class="pre-title">Genres</span><span class="space">:</span>
    <a href="/genre/action" class="badge label-badge">Action</a>
    <a href="/genre/adventure" class="badge label-badge">Adventure</a>
    <a href="/genre/shounen" class="badge label-badge">Shounen</a>
  </p>
</div>
<div class="summary"><p class="title">Summary</p><p class="content"> Gol D. Roger. </p></div>
<div class="list-group">
  <a class="list-group-item" href="${HOST}/read/55/2">Chapter 2 : Buggy<p class="text-right">Jun 22, 2026</p></a>
  <a class="list-group-item" href="${HOST}/read/55/1">Chapter 1 : Romance Dawn<p class="text-right">Jun 21, 2026</p></a>
</div>
</body></html>`;

/** the same page for a title with NO artist row — one paragraph shorter, and completed. */
const DETAIL_NO_ARTISTS = `<html><body>
<img class="img-manga" src="https://cdnxyz.xyz/web/cover/841/thumbnail.png" title="Naruto" alt="Naruto">
<div class="col-md-7">
  <hr>
  <p><span class="pre-title">Authors</span><span class="space">:</span> <a href="/author/kishimoto-masashi">Kishimoto, Masashi</a> </p>
  <p><span class="pre-title">Status</span><span class="space">:</span><span class="text-completed">Completed</span></p>
  <p><span class="pre-title">Genres</span><span class="space">:</span>
    <a href="/genre/action" class="badge label-badge">Action</a>
    <a href="/genre/martial-arts" class="badge label-badge">Martial Arts</a>
  </p>
</div>
<div class="summary"><p class="title">Summary</p><p class="content"> Believe it. </p></div>
<div class="list-group">
  <a class="list-group-item" href="${HOST}/read/841/1">Chapter 1<p class="text-right">Jan 1, 2020</p></a>
</div>
</body></html>`;

/** a page that carries no Status row at all — the row order says nothing about what is present. */
const DETAIL_NO_STATUS = `<html><body>
<img class="img-manga" src="https://cdnxyz.xyz/web/cover/9/thumbnail.png" title="Nameless" alt="Nameless">
<div class="col-md-7">
  <hr>
  <p><span class="pre-title">Authors</span><span class="space">:</span> <a href="/author/anon">Anon</a> </p>
  <p><span class="pre-title">Genres</span><span class="space">:</span>
    <a href="/genre/drama" class="badge label-badge">Drama</a>
  </p>
</div>
<div class="summary"><p class="title">Summary</p><p class="content"> Nothing. </p></div>
<div class="list-group"></div>
</body></html>`;

/** one search card in the CURRENT markup: cover URL on a lazy <img data-src>. */
const card = (id, title, chapter) => `
<div class="col-lg-2 col-md-3 col-4">
  <div class="comic-item">
    <a href="/manga/${title.toLowerCase().replace(/\W+/g, '-')}">
      <div class="comic-image">
        <img class="image lozad" data-src="https://cdnxyz.xyz/web/cover/${id}/thumbnail.png" src="/web/img/blank.gif" title="${title}"/>
        <button class="btn btn-bookmark" onclick="toggleBookmark(event,'${id}');" manga_id="${id}"></button>
        <span class="comic-completed"></span>
        <span class="tray-item">${chapter}</span>
      </div>
      <div class="comic-title"> ${title} </div>
    </a>
  </div>
</div>`;

/** the same card in the OLDER markup, cover URL on the wrapper div — must still parse. */
const legacyCard = (id, title, chapter) => `
<div class="col-lg-2 col-md-3 col-4">
  <div class="comic-item">
    <a href="/manga/legacy-${id}">
      <div class="comic-image" data-background-image="https://cdnxyz.xyz/web/cover/${id}/thumbnail.png">
        <span class="tray-item">${chapter}</span>
      </div>
      <div class="comic-title"> ${title} </div>
    </a>
  </div>
</div>`;

const searchPage1 = `<html><body>
<div class="row book-list">
  ${card(80, 'Kaguya-sama wa Kokurasetai', 'Chapter 281.1')}
  ${legacyCard(65732, 'Kaguya-Sama Legacy Card', 'Chapter 12')}
</div>
<ul class="pagination">
  <li class="page-item disabled"><span class="page-link"><i class="far fa-chevron-left"></i></span></li>
  <li class="page-item active" aria-current="page"><span class="page-link">1</span></li>
  <li class="page-item"><a class="page-link" href="${HOST}/search?page=2">2</a></li>
  <li class="page-item"><a class="page-link" href="${HOST}/search?page=2" rel="next"><i class="far fa-chevron-right"></i></a></li>
</ul>
</body></html>`;

/** the LAST page: the active <li> is a <span>, and Next is a disabled <span> with no anchor. */
const searchPage2 = `<html><body>
<div class="row book-list">
  ${card(99, 'Kaguya Fancomic', 'Chapter 5')}
</div>
<ul class="pagination">
  <li class="page-item"><a class="page-link" href="${HOST}/search?page=1" rel="prev"><i class="far fa-chevron-left"></i></a></li>
  <li class="page-item"><a class="page-link" href="${HOST}/search?page=1">1</a></li>
  <li class="page-item active" aria-current="page"><span class="page-link">2</span></li>
  <li class="page-item disabled"><span class="page-link"><i class="far fa-chevron-right"></i></span></li>
</ul>
</body></html>`;

const searchNoPagination = `<html><body>
<div class="row book-list">${card(7, 'Only One Hit', 'Chapter 1')}</div>
</body></html>`;

const SEARCH_JSON = {
  result: [
    {
      authors: [{ id: 1, name: 'Oda, Eiichiro', name_url: 'oda-eiichiro' }],
      completed: 0,
      created_at: '2019-01-01',
      description: 'Gol D. Roger.',
      id: 55,
      lastChapter: 'Chapter 1160',
      latest_chapter_id: 999,
      main_manga_id: null,
      name: 'One Piece',
      name_url: 'one-piece',
      scored: 9.2,
      status: 2,
      thumbnail: 'https://cdnxyz.xyz/web/cover/55/thumbnail.png',
      title: 'ONE PIECE, ワンピース,',
      updated_at: '2026-08-01',
      viewed: 12345,
      voted: 678,
    },
  ],
};

/** a chapter page. Two Google pages capped at different widths, one non-Google URL with no cap. */
const CHAPTER_PAGE = `<html><body>
<div class="vview carousel-inner">
  <div class="carousel-item"><img data-src="https://2.bp.blogspot.com/drive-storage/AJQWtBNoj-DMFG=w700"/></div>
  <div class="carousel-item"><img data-src="https://2.bp.blogspot.com/drive-storage/AJQWtBNbPUu7uH9=w1200"/></div>
  <div class="carousel-item"><img data-src="https://cdn.example/pages/1.jpg"/></div>
</div>
<div class="img-same-author"><img data-src="https://cdnxyz.xyz/web/cover/40302/thumbnail.png"/></div>
</body></html>`;

const ROUTES = {
  [`${HOST}/api/manga/search?search=one%20piece&uid=`]: SEARCH_JSON,
  [`${HOST}/api/manga-detail/55?userid=`]: DETAIL_WITH_ARTISTS,
  [`${HOST}/api/manga-detail/841?userid=`]: DETAIL_NO_ARTISTS,
  [`${HOST}/api/manga-detail/9?userid=`]: DETAIL_NO_STATUS,
  [`${HOST}/search?search_po=0&q=kaguya&page=1`]: searchPage1,
  [`${HOST}/search?search_po=0&q=kaguya&page=2`]: searchPage2,
  [`${HOST}/search?search_po=0&q=solo&page=1`]: searchNoPagination,
  [`${HOST}/read/55/1`]: CHAPTER_PAGE,
};

const p = () => provider(fakeAdapter(ROUTES));

// ---------------------------------------------------------------------------------------------

describe('VyvyManga addresses the renamed host, never the dead one', () => {
  test('search, searchApi, fetchMangaInfo and the logo all point at mangavyvy.net', async () => {
    const adapter = fakeAdapter(ROUTES);
    const prov = provider(adapter);
    await prov.search('kaguya');
    await prov.searchApi('one piece');
    await prov.fetchMangaInfo('55');

    assert.ok(adapter.seen.length >= 3, `expected three requests, saw ${adapter.seen.length}`);
    for (const url of adapter.seen) {
      assert.ok(url.startsWith(HOST), `request did not go to ${HOST}: ${url}`);
      assert.doesNotMatch(url, /vyvymanga\.net/, `request went to the DEAD origin: ${url}`);
    }
    assert.doesNotMatch(prov.logo, /vyvymanga\.net/, `logo still on the dead origin: ${prov.logo}`);
    assert.match(prov.logo, /mangavyvy\.net/);
  });

  test('the api base and the website base are the same renamed host', () => {
    const prov = new VyvyManga();
    assert.equal(prov.baseUrl, `${HOST}/api`);
    assert.equal(prov.baseWebsiteUrl, HOST);
    assert.ok(!prov.baseUrl.includes(DEAD_HOST) && !prov.baseWebsiteUrl.includes(DEAD_HOST));
  });

  test('a request to the dead host is what a dead host looks like — the transport refuses it', async () => {
    // guards the guard: if this passed, the host assertions above would be vacuous.
    const adapter = fakeAdapter(ROUTES);
    await assert.rejects(adapter({ url: `https://${DEAD_HOST}/api/manga-detail/55?userid=` }), /ECONNREFUSED/);
  });
});

describe('fetchMangaInfo reads the info block by label, not by position', () => {
  test('a title WITH an Artists row still yields status and genres', async () => {
    // The regression case. Positional lookup read p[1] (Artists) for status and p[2] (Status) for
    // genres here, producing "" and [] — live-confirmed against manga 55 before the fix.
    const info = await p().fetchMangaInfo('55');
    assert.equal(info.title, 'One Piece');
    assert.equal(info.status, 'Ongoing', 'status came back empty — positional read of a shifted row');
    assert.deepEqual(info.genres, ['Action', 'Adventure', 'Shounen']);
    assert.deepEqual(info.authors, ['Oda, Eiichiro'], 'authors must be the Authors row, not the Artists row');
    assert.equal(info.img, 'https://cdnxyz.xyz/web/cover/55/thumbnail.png');
    assert.equal(info.description, 'Gol D. Roger.');
  });

  test('a title WITHOUT an Artists row is unaffected', async () => {
    const info = await p().fetchMangaInfo('841');
    assert.equal(info.title, 'Naruto');
    assert.equal(info.status, 'Completed');
    assert.deepEqual(info.genres, ['Action', 'Martial Arts']);
    assert.deepEqual(info.authors, ['Kishimoto, Masashi']);
  });

  test('a missing Status row reports Unknown rather than an empty string', async () => {
    const info = await p().fetchMangaInfo('9');
    assert.equal(info.status, 'Unknown');
    assert.deepEqual(info.genres, ['Drama'], 'genres must still be found when an earlier row is absent');
  });

  test('chapters come back oldest-first, and each id is a full absolute URL', async () => {
    // The id IS a URL — fetchChapterPages GETs it directly. Anything that persists a chapter id is
    // persisting a hostname, and will not follow a future rename. Pinned so that stays visible.
    const info = await p().fetchMangaInfo('55');
    assert.equal(info.chapters.length, 2);
    assert.equal(info.chapters[0].title, 'Chapter 1 : Romance Dawn');
    assert.equal(info.chapters[0].releaseDate, 'Jun 21, 2026');
    for (const ch of info.chapters) assert.match(ch.id, /^https?:\/\//, `chapter id is not a url: ${ch.id}`);
  });
});

describe('search() reads the card the way the card is actually built', () => {
  test('the manga id and cover come off the lazy <img data-src>', async () => {
    const res = await p().search('kaguya');
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].id, '80', 'id must be numeric — fetchMangaInfo takes the numeric id');
    assert.equal(res.results[0].title, 'Kaguya-sama wa Kokurasetai');
    assert.equal(res.results[0].image, 'https://cdnxyz.xyz/web/cover/80/thumbnail.png');
    assert.equal(res.results[0].lastChapter, 'Chapter 281.1');
  });

  test('the older data-background-image card shape still parses', async () => {
    const res = await p().search('kaguya');
    assert.equal(res.results[1].id, '65732');
    assert.equal(res.results[1].image, 'https://cdnxyz.xyz/web/cover/65732/thumbnail.png');
  });

  test('every result carries a usable id — none silently blank', async () => {
    const res = await p().search('kaguya');
    for (const r of res.results) assert.match(r.id, /^\d+$/, `unusable id: ${JSON.stringify(r)}`);
  });

  test('page 1 of 2 reports a next page', async () => {
    const res = await p().search('kaguya', 1);
    assert.equal(res.currentPage, 1);
    assert.equal(res.totalPages, 2);
    assert.equal(res.hasNextPage, true);
  });

  test('the LAST page reports no next page and a real page count', async () => {
    // Positional pagination read the active <li> here, which has no <a>: totalPages was NaN and
    // hasNextPage was true, so a paging caller looped forever.
    const res = await p().search('kaguya', 2);
    assert.equal(res.currentPage, 2);
    assert.equal(res.totalPages, 2, 'totalPages must be a number, not NaN');
    assert.ok(Number.isFinite(res.totalPages));
    assert.equal(res.hasNextPage, false);
  });

  test('a single-page result set with no pagination control', async () => {
    const res = await p().search('solo');
    assert.equal(res.results.length, 1);
    assert.equal(res.totalPages, 1);
    assert.equal(res.hasNextPage, false);
  });

  test('page < 1 is rejected', async () => {
    await assert.rejects(p().search('kaguya', 0), /page must be equal to 1 or greater/);
  });
});

describe('fetchChapterPages strips the Google size cap and nothing else', () => {
  test('the =w<n> suffix is removed so the full-resolution original is served', async () => {
    const pages = await p().fetchChapterPages(`${HOST}/read/55/1`);
    assert.equal(pages.length, 3, 'only the carousel images are pages — not the same-author covers');
    assert.equal(pages[0].img, 'https://2.bp.blogspot.com/drive-storage/AJQWtBNoj-DMFG');
    assert.equal(pages[0].page, 1);
  });

  test('a cap that is not exactly five characters is still fully removed', async () => {
    // `.slice(0, -5)` left a trailing `=` on `=w1200`, which 404s.
    const pages = await p().fetchChapterPages(`${HOST}/read/55/1`);
    assert.equal(pages[1].img, 'https://2.bp.blogspot.com/drive-storage/AJQWtBNbPUu7uH9');
    assert.doesNotMatch(pages[1].img, /=$/);
  });

  test('a URL with no size cap is passed through untouched', async () => {
    // `.slice(0, -5)` turned this into `https://cdn.example/pages/`.
    const pages = await p().fetchChapterPages(`${HOST}/read/55/1`);
    assert.equal(pages[2].img, 'https://cdn.example/pages/1.jpg');
  });

  test('no page URL escapes with a size cap still attached', async () => {
    const pages = await p().fetchChapterPages(`${HOST}/read/55/1`);
    for (const pg of pages) assert.doesNotMatch(pg.img, /=[ws]\d+$/, `size cap survived: ${pg.img}`);
  });
});

describe('searchApi (the JSON endpoint) still maps the documented contract', () => {
  test('alt titles split on comma and empty trailing entries are dropped', async () => {
    const res = await p().searchApi('one piece');
    assert.equal(res.totalResults, 1);
    const r = res.results[0];
    assert.equal(r.id, '55');
    assert.equal(r.title, 'One Piece');
    assert.deepEqual(r.altTitles, ['ONE PIECE', 'ワンピース']);
    assert.equal(r.status, 'Ongoing');
    assert.equal(r.lastChapter, 'Chapter 1160');
    assert.equal(r.image, 'https://cdnxyz.xyz/web/cover/55/thumbnail.png');
  });

  test('it sends the Referer the API expects, on the renamed host', async () => {
    const seenHeaders = [];
    const adapter = async config => {
      seenHeaders.push(config.headers);
      return { data: SEARCH_JSON, status: 200, statusText: 'OK', headers: {}, config };
    };
    const prov = provider(adapter);
    await prov.searchApi('one piece');
    const referer = seenHeaders[0].Referer ?? seenHeaders[0].referer;
    assert.equal(referer, `${HOST}/`);
  });
});
