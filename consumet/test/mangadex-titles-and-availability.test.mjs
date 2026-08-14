// MangaDex — title resolution, unreadable chapters, and the mandatory User-Agent.
//
// WHAT THIS PROTECTS. Three defects that all *looked* like the provider working:
//
//  1. `title: undefined`. The code read `attributes.title.en`, but MangaDex's `title` is a
//     `{ [language]: string }` map and most entries have no `en` key at all — Berserk's is literally
//     `{"ja-ro":"Berserk"}`, Solo Leveling's is `{"ko-ro":"Na Honjaman Level-Up"}`. Measured live
//     against the 200 most-followed manga: 183 (91.5%) carried no `en` title, so `title` came back
//     undefined for nearly the whole catalogue while every other field looked fine.
//
//  2. Chapters that silently returned ZERO pages. MangaDex indexes chapters it holds no images for
//     (MangaPlus / Webnovel stubs), in two distinct shapes, both reproduced live:
//       - `/at-home/server/{id}` 404s — One Piece's English chapters;
//       - `/at-home/server/{id}` answers HTTP **200** with `{"chapter":{"hash":"","data":[]}}` —
//         all 24 English chapters of Solo Leveling, the site's most-followed manga.
//     The old code turned the second into `return []` with no error whatsoever, so a caller could
//     not tell "unreadable here" from "genuinely empty". It now throws, the way every other
//     provider in this tree signals not-available, and fetchMangaInfo pre-flags the chapters with
//     `readable` / `externalUrl` so a caller never has to hit the throw.
//
//  3. The User-Agent is mandatory. api.mangadex.org, mangadex.org and uploads.mangadex.org each
//     answer HTTP 400 "You must set an appropriate User-Agent header" without one. The provider
//     sent no headers and only worked by accident, because Node's undici fills in `User-Agent:
//     node` — an accident that dies the moment the transport changes.
//
// Offline: every HTTP call is served by a fake axios adapter installed on the provider's own axios
// instance, so the real request wiring (including the headers it sends) is exercised with no
// network. Live checking is what the ts-node probe is for.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/manga/mangadex.js');
const MangaDex = mod.default ?? mod;
const { USER_AGENT } = require('../dist/utils/utils.js');

/**
 * axios adapter over a {url-substring → response} map, longest match wins. A value may be
 * `{ __status, __body }` to reject the way axios does for a non-2xx, or a plain body for a 200.
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
    if (hit === undefined) throw new Error(`ECONNREFUSED ${url}`);
    const route = routes[hit];
    if (route && route.__status) {
      // shaped exactly like a real axios rejection, which is what the provider branches on
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
  const p = new MangaDex();
  p.client.defaults.adapter = adapter;
  return p;
};

// ---------------------------------------------------------------------------- fixtures

/** a manga document as /manga/{id} returns it */
const mangaDoc = (id, title, altTitles = []) => ({
  result: 'ok',
  data: {
    id,
    attributes: {
      title,
      altTitles,
      description: { en: 'desc-en', ru: 'desc-ru' },
      tags: [
        { attributes: { group: 'genre', name: { en: 'Action' } } },
        { attributes: { group: 'theme', name: { en: 'Monsters' } } },
      ],
      status: 'completed',
      year: 1989,
    },
    relationships: [{ type: 'cover_art', id: 'cov-1' }],
  },
});

/** one page of /manga/{id}/feed. total <= 96 so fetchAllChapters stops after this response. */
const feed = chapters => ({ result: 'ok', data: chapters, limit: 96, offset: 0, total: chapters.length });

const chapterRec = (id, { chapter, pages, externalUrl = null }) => ({
  id,
  attributes: { title: null, chapter, volume: '1', pages, externalUrl, translatedLanguage: 'en' },
});

const COVER = { result: 'ok', data: { attributes: { fileName: 'cover.jpg' } } };

// Berserk: no `en` in the title map, `en` present in altTitles.
const BERSERK = '801513ba-a712-498c-8f57-cae55b38cc92';
// Solo Leveling: ko-ro title map, official English name only in altTitles, all chapters external.
const SOLO = '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0';

const BERSERK_ALTS = [{ ja: 'ベルセルク' }, { de: 'Berserk' }, { en: 'Berserk' }];
const SOLO_ALTS = [
  { ko: '나 혼자만 레벨업' },
  { en: 'Solo Leveling' },
  { 'ko-ro': 'Na Honjaman Lebel-eob' },
  { en: 'I level up alone' },
];

const berserkRoutes = () => ({
  [`/manga/${BERSERK}/feed`]: feed([chapterRec('ch-good', { chapter: '1', pages: 2 })]),
  [`/manga/${BERSERK}`]: mangaDoc(BERSERK, { 'ja-ro': 'Berserk' }, BERSERK_ALTS),
  '/cover/cov-1': COVER,
});

const SOLO_EXTERNAL_URL = 'https://www.webnovel.com/comic/15227640605485101/45196977385821028';

const soloRoutes = () => ({
  [`/manga/${SOLO}/feed`]: feed([
    chapterRec('ch-webnovel', { chapter: '15', pages: 0, externalUrl: SOLO_EXTERNAL_URL }),
    chapterRec('ch-good', { chapter: '1', pages: 2 }),
  ]),
  [`/manga/${SOLO}`]: mangaDoc(SOLO, { 'ko-ro': 'Na Honjaman Level-Up' }, SOLO_ALTS),
  '/cover/cov-1': COVER,
});

// ---------------------------------------------------------------------------- 1. titles

describe('MangaDex resolves a title even when the title map has no `en` key', () => {
  test('Berserk — `{"ja-ro":"Berserk"}` resolves instead of coming back undefined', async () => {
    const info = await provider(fakeAdapter(berserkRoutes())).fetchMangaInfo(BERSERK);
    // reading .title.en gave `undefined` here, for 89% of the top 500
    assert.equal(info.title, 'Berserk');
    assert.equal(typeof info.title, 'string');
  });

  test('Solo Leveling — a `ko-ro` title map resolves, and the English name is exposed too', async () => {
    const info = await provider(fakeAdapter(soloRoutes())).fetchMangaInfo(SOLO);
    assert.equal(info.title, 'Na Honjaman Level-Up');
    // the officially published English title lives in altTitles for romanised entries
    assert.equal(info.englishTitle, 'Solo Leveling');
  });

  test('`en` is preferred whenever the title map actually has one', async () => {
    const id = 'en-present';
    const title = { ru: 'Берсерк', 'ja-ro': 'Kaguya-sama wa Kokurasetai', en: 'Kaguya-sama: Love is War' };
    const routes = {
      [`/manga/${id}/feed`]: feed([]),
      [`/manga/${id}`]: mangaDoc(id, title),
      '/cover/cov-1': COVER,
    };
    const info = await provider(fakeAdapter(routes)).fetchMangaInfo(id);
    assert.equal(info.title, 'Kaguya-sama: Love is War');
  });

  test('a title map with no preferred language at all still yields a string, never undefined', async () => {
    const id = 'ru-only';
    const routes = {
      [`/manga/${id}/feed`]: feed([]),
      [`/manga/${id}`]: mangaDoc(id, { ru: 'Одна только я повышаю уровень' }),
      '/cover/cov-1': COVER,
    };
    const info = await provider(fakeAdapter(routes)).fetchMangaInfo(id);
    assert.equal(info.title, 'Одна только я повышаю уровень');
  });

  test('an empty title map falls through to altTitles rather than returning undefined', async () => {
    const id = 'empty-title';
    const routes = {
      [`/manga/${id}/feed`]: feed([]),
      [`/manga/${id}`]: mangaDoc(id, {}, [{ ja: '進撃の巨人' }, { en: 'Attack on Titan' }]),
      '/cover/cov-1': COVER,
    };
    const info = await provider(fakeAdapter(routes)).fetchMangaInfo(id);
    assert.equal(info.title, 'Attack on Titan');
  });

  test('the list endpoints use the same preference — search picks `en` over the first key', async () => {
    // search() used to take Object.values(title)[0], i.e. whatever key happened to come first.
    const routes = {
      '/manga?limit=': {
        result: 'ok',
        data: [
          {
            id: 'kaguya',
            attributes: {
              title: { 'ja-ro': 'Kaguya-sama wa Kokurasetai', en: 'Kaguya-sama: Love is War' },
              altTitles: [{ en: 'Kaguya Wants to be Confessed To' }],
              description: { ru: 'описание', en: 'english description' },
              status: 'completed',
              year: 2015,
              contentRating: 'safe',
            },
            relationships: [{ type: 'cover_art', id: 'cov-1' }],
          },
        ],
      },
      '/cover/cov-1': COVER,
    };
    const res = await provider(fakeAdapter(routes)).search('kaguya');
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].title, 'Kaguya-sama: Love is War');
    assert.equal(res.results[0].description, 'english description');
  });
});

// ------------------------------------------------------- 2. chapters with no images on MangaDex

describe('MangaDex refuses to pass an unreadable chapter off as a zero-page one', () => {
  const externalRoutes = () => ({
    // Solo Leveling's shape: HTTP 200, empty page list, no error anywhere.
    '/at-home/server/ch-webnovel': {
      result: 'ok',
      baseUrl: 'https://node.example',
      chapter: { hash: '', data: [], dataSaver: [] },
    },
    '/chapter/ch-webnovel': {
      result: 'ok',
      data: { id: 'ch-webnovel', attributes: { externalUrl: 'https://www.webnovel.com/comic/152/451' } },
    },
    // One Piece's shape: the at-home lookup 404s outright.
    '/at-home/server/ch-mangaplus': { __status: 404, __body: { result: 'error', errors: [{ status: 404 }] } },
    '/chapter/ch-mangaplus': {
      result: 'ok',
      data: { id: 'ch-mangaplus', attributes: { externalUrl: 'https://mangaplus.shueisha.co.jp/viewer/1029611' } },
    },
    // a real, readable chapter
    '/at-home/server/ch-good': {
      result: 'ok',
      baseUrl: 'https://node.example',
      chapter: { hash: 'abc123', data: ['1-aaa.png', '2-bbb.png'], dataSaver: ['1-aaa.jpg', '2-bbb.jpg'] },
    },
  });

  test('HTTP 200 with an empty page list THROWS instead of resolving to []', async () => {
    const p = provider(fakeAdapter(externalRoutes()));
    await assert.rejects(p.fetchChapterPages('ch-webnovel'), err => {
      assert.match(err.message, /not readable on MangaDex/i, 'must say the chapter is unreadable');
      assert.match(err.message, /ch-webnovel/, 'must name the chapter');
      assert.match(err.message, /webnovel\.com/, 'must point at where the pages actually are');
      return true;
    });
  });

  test('an at-home 404 reports the diagnosis, not the bare axios message', async () => {
    const p = provider(fakeAdapter(externalRoutes()));
    await assert.rejects(p.fetchChapterPages('ch-mangaplus'), err => {
      assert.match(err.message, /not readable on MangaDex/i);
      assert.match(err.message, /mangaplus\.shueisha\.co\.jp/, 'must point at where the pages actually are');
      assert.match(err.message, /404/);
      assert.notEqual(
        err.message,
        'Request failed with status code 404',
        'the raw axios message tells a caller nothing'
      );
      return true;
    });
  });

  test('a readable chapter still returns its pages, unchanged', async () => {
    const pages = await provider(fakeAdapter(externalRoutes())).fetchChapterPages('ch-good');
    assert.equal(pages.length, 2);
    assert.equal(pages[0].img, 'https://node.example/data/abc123/1-aaa.png');
    assert.equal(pages[0].page, 1);
    assert.equal(pages[1].img, 'https://node.example/data/abc123/2-bbb.png');
    assert.equal(pages[1].page, 2);
  });

  test('fetchMangaInfo pre-flags unreadable chapters so a caller never has to hit the throw', async () => {
    const info = await provider(fakeAdapter(soloRoutes())).fetchMangaInfo(SOLO);
    const stub = info.chapters.find(c => c.id === 'ch-webnovel');
    const good = info.chapters.find(c => c.id === 'ch-good');

    assert.equal(stub.readable, false, 'an externalUrl chapter must be flagged unreadable');
    assert.equal(stub.externalUrl, SOLO_EXTERNAL_URL);
    assert.equal(stub.pages, 0);

    assert.equal(good.readable, true);
    assert.equal(good.externalUrl, null);
    assert.equal(good.pages, 2);
  });
});

// ---------------------------------------------------------------------------- 3. User-Agent

describe('MangaDex sends the mandatory User-Agent explicitly', () => {
  const uaOf = headers =>
    typeof headers.get === 'function' ? headers.get('User-Agent') : headers['User-Agent'] ?? headers['user-agent'];

  test('every request the provider makes carries the shared USER_AGENT', async () => {
    // Without one, all three MangaDex hosts answer HTTP 400 "You must set an appropriate
    // User-Agent header". Relying on undici's implicit `User-Agent: node` is not sending one.
    const adapter = fakeAdapter(soloRoutes());
    await provider(adapter).fetchMangaInfo(SOLO);

    assert.ok(adapter.seen.length >= 3, `expected several requests, saw ${adapter.seen.length}`);
    for (const { url, headers } of adapter.seen)
      assert.equal(uaOf(headers), USER_AGENT, `no explicit User-Agent on ${url}`);
  });

  test('the chapter-pages request carries it too, and the pages say what to send for the images', async () => {
    const adapter = fakeAdapter({
      '/at-home/server/ch-good': {
        result: 'ok',
        baseUrl: 'https://node.example',
        chapter: { hash: 'abc123', data: ['1-aaa.png'], dataSaver: ['1-aaa.jpg'] },
      },
    });
    const pages = await provider(adapter).fetchChapterPages('ch-good');

    assert.equal(adapter.seen.length, 1);
    assert.equal(uaOf(adapter.seen[0].headers), USER_AGENT);
    assert.equal(pages[0].headers['User-Agent'], USER_AGENT);
  });

  test('fetchMangaInfo hands back the headers needed for the cover image', async () => {
    const info = await provider(fakeAdapter(berserkRoutes())).fetchMangaInfo(BERSERK);
    // mangadex.org/covers 400s without a User-Agent exactly like the API does
    assert.equal(info.headers['User-Agent'], USER_AGENT);
    assert.equal(info.image, `https://mangadex.org/covers/${BERSERK}/cover.jpg`);
  });
});
