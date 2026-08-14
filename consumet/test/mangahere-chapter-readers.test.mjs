// MangaHere ships TWO chapter readers, and which one you get is decided PER CHAPTER.
//
// WHAT THIS PROTECTS.
//
// 1. THE `chapter_bar` BRANCH IS LIVE. An audit pass sampled four chapters, found no `chapter_bar`
//    script in any of them, declared the branch "a page layout that NO LONGER EXISTS" that "appears
//    in exactly zero chapters", and downgraded every risk inside it on that basis. It was wrong:
//    branch selection is per-chapter, not per-series. Probed live 2026-08-14 — berserk/c001,
//    berserk/c200, berserk/c364, solo_leveling/c001 and solo_leveling/c010 take the chapter_bar
//    branch; chainsaw_man/c001, one_piece/v98/c1190, kaguya/c001, jujutsu_kaisen/c001 and
//    oyasumi_punpun/c001 take the other one. Same site, same day. These tests keep the branch
//    exercised so nobody deletes it as dead code again.
//
// 2. THE REFERER WAS WRONG THERE. The push read `Referer: url` from inside `urls.map((url, i) => …)`,
//    where `url` shadowed the chapter page URL with the image's own protocol-relative path, so every
//    page went out with `Referer: //zjcdn.mangahere.org/…`. It only worked by accident: the CDN's
//    hotlink check is a bare substring test for "mangahere", which its own hostname satisfies.
//    Confirmed live: chapter-page Referer → 200, absent or unrelated Referer → 403.
//
// 3. THE ARRAY PARSE WAS UNGUARDED. `ds.split("['")[1].split("']")[0]` throws
//    "Cannot read properties of undefined (reading 'split')" the moment the script shape moves —
//    naming neither the provider nor the chapter. It now fails with a diagnosable message instead.
//
// 4. THE TRAILING SOFT-404. Every chapter's image list ends in one booby-trapped entry whose filename
//    is the real last page's with a single character swapped (`/s051.jpg` → `/s05a.jpg`). The CDN
//    answers it 200 with a genuinely decodable 1000x563 PNG (exactly 206523 bytes, sha256
//    7dbfad65d99112b7…), so status codes and magic bytes do NOT catch it. The site flags it in its
//    own data by repeating the previous page's image id — `newImginfos`'s last two entries in the
//    chapter_bar reader, a repeated `currentimageid` in the other — and that is what we key off.
//    Across the nine chapters probed above there was exactly one repeated id each, always at the
//    final index, so the rule cannot swallow a real page.
//
// Offline: a fake axios adapter serves every request, so the real provider wiring runs with no
// network. Live checking is what the ts-node probes are for.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/manga/mangahere.js');
const MangaHere = mod.default ?? mod;

const BASE = 'http://www.mangahere.cc';
const CDN = '//zjcdn.mangahere.org/store/manga/9/001.0/compressed';

/**
 * Wrap text in a real P.A.C.K.E.R call that expands back to exactly that text: with a symbol count of
 * 0 the keyword dictionary is empty, so the payload passes through untouched. This is a genuine
 * packer payload, not a stub — `unpackPacker` parses it the same way it parses MangaHere's.
 */
const packed = payload =>
  `eval(function(p,a,c,k,e,d){return p}('${payload.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',10,0,''.split('|'),0,{}))`;

/** a chapter page served by the `chapter_bar` reader: images inline, in one packed script */
const chapterBarPage = script =>
  `<html><head><script type="text/javascript" src="//static.mangahere.cc/v20260227/mangahere/js/chapter_bar.js"></script></head>` +
  `<body><div class="reader-main"></div><script>${packed(script)}</script></body></html>`;

const newImgsScript = (files, ids) =>
  `var newImgs=[${files.map(f => `'${CDN}${f}'`).join(',')}];var newImginfos=[${ids.join(',')}];`;

/** a chapter page served by the OTHER reader: a page key, a chapter id, a pager, images over ajax */
const chapterFunPage = (key, chapterId, pages) =>
  `<html><head></head><body>` +
  `<div></div><div></div><div></div><div></div><div></div>` +
  `<div><div><span>` +
  Array.from({ length: pages }, (_, i) => `<a data-page="${i + 1}" href="#">${i + 1}</a>`).join('') +
  `<a data-page="2" href="#">&gt;</a>` +
  `</span></div></div>` +
  `<script>${packed(`var key='${key.split('').join("'+'")}';`)}</script>` +
  `<script>var chapterid = ${chapterId};</script>` +
  `</body></html>`;

/** one chapterfun.ashx answer: `pvalue[0]` is this page's image, and `currentimageid` tags it */
const chapterFunAnswer = (file, imageId) =>
  packed(
    `function dm5imagefun(){var pix="${CDN}";var pvalue=["${file}","/next.jpg"];` +
      `for(var i=0;i<pvalue.length;i++){pvalue[i]=pix+pvalue[i]}return pvalue}` +
      `var d;d=dm5imagefun();currentimageid=${imageId};`
  );

/** axios adapter over a {url-substring → body} map; anything unmatched rejects. `seen` records all. */
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
  const p = new MangaHere();
  p.client.defaults.adapter = adapter;
  return p;
};

const CHAPTER = 'berserk/c001';
const CHAPTER_URL = `${BASE}/manga/${CHAPTER}/1.html`;

/** a chapter_bar chapter: 3 image entries, the last one the decoy (its id repeats page 2's) */
const barRoutes = script => ({ [CHAPTER_URL]: chapterBarPage(script) });

const barPages = (script = newImgsScript(['/a001.jpg', '/a002.jpg', '/a00a.jpg'], [111, 112, 112])) =>
  provider(fakeAdapter(barRoutes(script))).fetchChapterPages(CHAPTER);

describe('MangaHere chapter_bar reader (live, not dead code)', () => {
  test('a chapter_bar page yields pages at all', async () => {
    // If someone deletes this branch again, a chapter_bar page falls through to the ajax reader,
    // which finds no pager on it and returns [] — silently, for berserk and solo_leveling alike.
    const pages = await barPages();
    assert.ok(pages.length > 0, 'the chapter_bar branch produced nothing — was it removed?');
    assert.equal(pages[0].img, `https:${CDN}/a001.jpg`);
  });

  test('Referer is the CHAPTER PAGE, never the image url', async () => {
    const pages = await barPages();
    for (const [i, p] of pages.entries()) {
      assert.equal(p.headerForImage.Referer, CHAPTER_URL, `page ${i} sent the wrong Referer`);
      // the exact regression: the image's own protocol-relative path, via a shadowed `url`
      assert.doesNotMatch(
        p.headerForImage.Referer,
        /^\/\//,
        `page ${i} sent the image path as its own Referer — the map callback is shadowing \`url\` again`
      );
      assert.notEqual(p.headerForImage.Referer, p.img, `page ${i} sent its own image url as Referer`);
    }
  });

  test('the trailing soft-404 decoy is dropped, keyed on the repeated image id', async () => {
    const pages = await barPages();
    assert.equal(pages.length, 2, 'the decoy entry survived (or a real page was eaten)');
    assert.deepEqual(
      pages.map(p => p.img),
      [`https:${CDN}/a001.jpg`, `https:${CDN}/a002.jpg`]
    );
    assert.ok(
      !pages.some(p => p.img.endsWith('/a00a.jpg')),
      'the decoy image — 200 OK, a real decodable PNG, 206523 bytes — is still in the list'
    );
    assert.deepEqual(
      pages.map(p => p.page),
      [0, 1],
      'page numbers must stay contiguous after the drop'
    );
  });

  test('with no repeated id, nothing is dropped', async () => {
    // The rule must be driven by the site's own marker, not by "always trim the last entry".
    const pages = await barPages(newImgsScript(['/a001.jpg', '/a002.jpg', '/a003.jpg'], [111, 112, 113]));
    assert.equal(pages.length, 3, 'a chapter with no decoy lost a real page');
  });
});

describe('MangaHere chapter_bar reader fails diagnosably when the script shape moves', () => {
  const TYPE_ERROR = /Cannot read properties of undefined|is not a function|undefined is not an object/;

  const shapes = {
    'no image array at all': 'var somethingElse={a:1};',
    'array elements are not string literals': 'var newImgs=[notQuoted,alsoNotQuoted];var newImginfos=[1,2];',
    'array is empty': 'var newImgs=[];var newImginfos=[];',
  };

  for (const [label, script] of Object.entries(shapes)) {
    test(`${label} → an error naming MangaHere and the chapter`, async () => {
      await assert.rejects(barPages(script), err => {
        assert.match(err.message, /MangaHere/, `must name the provider: ${err.message}`);
        assert.match(err.message, /berserk\/c001/, `must name the chapter: ${err.message}`);
        assert.doesNotMatch(err.message, TYPE_ERROR, `raw TypeError leaked instead of a diagnosis: ${err.message}`);
        return true;
      });
    });
  }

  test('a relative image path is rejected, not silently turned into a broken url', async () => {
    // The old parse happily produced `https:/relative.jpg` here and shipped it to the caller.
    await assert.rejects(
      barPages(`var newImgs=['/relative.jpg','/relative2.jpg'];var newImginfos=[1,2];`),
      /MangaHere.*absolute image url/s
    );
  });
});

describe('MangaHere ajax reader', () => {
  const CID = 566434;
  const KEY = 'abc123';
  const AJAX_CHAPTER = 'chainsaw_man/c001';
  const AJAX_URL = `${BASE}/manga/${AJAX_CHAPTER}/1.html`;
  const fun = `${BASE}/manga/${AJAX_CHAPTER}/chapterfun.ashx?cid=${CID}`;

  const ajaxRoutes = () => ({
    [AJAX_URL]: chapterFunPage(KEY, CID, 3),
    [`${fun}&page=1&key=${KEY}`]: chapterFunAnswer('/s000.jpg', 501),
    [`${fun}&page=2&key=${KEY}`]: chapterFunAnswer('/s001.jpg', 502),
    // the decoy: a mutated filename whose currentimageid repeats page 2's
    [`${fun}&page=3&key=${KEY}`]: chapterFunAnswer('/s00a.jpg', 502),
  });

  test('drops the trailing decoy and keeps page numbers contiguous', async () => {
    const adapter = fakeAdapter(ajaxRoutes());
    const pages = await provider(adapter).fetchChapterPages(AJAX_CHAPTER);
    assert.deepEqual(
      pages.map(p => p.img),
      [`https:${CDN}/s000.jpg`, `https:${CDN}/s001.jpg`],
      'the decoy entry survived (or a real page was eaten)'
    );
    assert.deepEqual(pages.map(p => p.page), [0, 1]);
    for (const p of pages) assert.equal(p.headerForImage.Referer, AJAX_URL);
    // and it really went through the ajax wiring rather than short-circuiting
    assert.equal(adapter.seen.filter(u => u.includes('chapterfun.ashx')).length, 3, adapter.seen.join('\n'));
  });

  test('a chapterfun response without pix=/pvalue= throws instead of building a garbage url', async () => {
    // `indexOf(…) + 5` on a missing needle is 4 — the old code sliced from there and returned a url
    // that merely looked plausible.
    const routes = ajaxRoutes();
    routes[`${fun}&page=2&key=${KEY}`] = packed('var nothingUseful=1;currentimageid=502;');
    await assert.rejects(provider(fakeAdapter(routes)).fetchChapterPages(AJAX_CHAPTER), err => {
      assert.match(err.message, /MangaHere/, err.message);
      assert.match(err.message, /pix=\/pvalue=/, err.message);
      assert.match(err.message, /chapterfun\.ashx/, err.message);
      return true;
    });
  });
});
