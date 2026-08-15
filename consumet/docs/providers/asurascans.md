<h1> AsuraScans </h1>

```ts
  const asuraScans = new MANGA.AsuraScans();
```

> **This provider was rewritten against a JSON API and every id shape changed.** It used to be
> pinned to `asuracomic.net`, which now 301s to `https://asurascans.com/` **discarding the path and
> the query** — so every request fetched the homepage, the old cheerio selectors matched nothing,
> and `fetchMangaInfo('anything')` *resolved* with `{ title: 'Popular', chapters: [] }` instead of
> throwing. It now reads `https://api.asurascans.com/api`, a clean unauthenticated JSON API, with
> **no HTML scraping on the primary path**.
>
> Ids are now bare slugs (`solo-leveling`), not `series/<slug>-<hash>`, and images are on
> `cdn.asurascans.com`, not `gg.asuracomic.net`. A full series URL such as
> `https://asurascans.com/comics/solo-leveling-7e1f454a` is also accepted and normalises to the
> bare slug.

<h2>Methods</h2>

- [search](#search)
- [fetchMangaInfo](#fetchmangainfo)
- [fetchChapterPages](#fetchchapterpages)

### search
> Note: This method is a subclass of the [`BaseParser`](https://github.com/consumet/extensions/blob/master/src/models/base-parser.ts) class, meaning it is available across most categories.

<h4>Parameters</h4>

| Parameter        | Type     | Description                                                      |
| ---------------- | -------- | ---------------------------------------------------------------- |
| query            | `string` | query to search for.                                             |
| page (optional)  | `number` | 1-based page number (default: 1)                                 |
| limit (optional) | `number` | results per page, **1..50** (default: 20)                        |

<h4>Three upstream behaviours that silently return the wrong answer</h4>

These are measured, not assumed, and the provider works around all three:

- **`page` is not a parameter upstream.** `?page=2`, `?page=3`, `?page=99` all return page **one**
  with `has_more: true` forever. The real cursor is `offset`, which is what this provider sends.
  (Two pages fetched with `page=` were byte-identical; with `offset=` they are disjoint.)
- **`limit` caps at 50 and does not clamp above it.** `limit=51`, `100`, `0` and `-1` all silently
  yield 20 rows. A limit outside `1..50` is therefore **refused** with an error rather than sent.
- **Past the last page `data` is `null`, not `[]`,** and `has_more` is *omitted* rather than sent as
  `false`.

There is deliberately **no `fetchPopular` / `fetchLatestUpdates`**: the `order` parameter is a coin
flip — any non-empty value produces one fixed alternative ordering and the value itself is ignored.

```ts
asuraScans.search('solo leveling').then(data => {
  console.log(data);
})
```
returns a promise which resolves into an array of manga. (*[`Promise<ISearch<IMangaResult[]>>`](https://github.com/consumet/extensions/blob/master/src/models/types.ts#L97-L106)*)\
output:
```js
{
    currentPage: 1,
    hasNextPage: false,
    totalPages: 1,
    totalResults: 2,
    results: [
    {
        id: 'solo-leveling-ragnarok',
        title: 'Solo Leveling: Ragnarok',
        altTitles: [ '나 혼자만 레벨업 : 라그나로크', 'Only I Level Up: Ragnarok', ... ],
        image: 'https://cdn.asurascans.com/asura-images/covers/solo-leveling-ragnarok.9ead3a.webp',
        status: 'Hiatus',
        type: 'manhwa',
        rating: 9.532385466034755,
        chapterCount: 68,
        latestChapter: '68',
        url: 'https://asurascans.com/comics/solo-leveling-ragnarok-7e1f454a'
    },
    {...},
    ]
}
```

### fetchMangaInfo

<h4>Parameters</h4>

| Parameter | Type     | Description                                                                |
| --------- | -------- | -------------------------------------------------------------------------- |
| mangaId   | `string` | bare series slug, or a full `asurascans.com/comics/...` URL                 |

```ts
asuraScans.fetchMangaInfo('solo-leveling').then(data => {
  console.log(data);
})
```
returns a promise which resolves into an manga info object (including the chapters). (*[`Promise<IMangaInfo>`](https://github.com/consumet/extensions/blob/master/src/models/types.ts#L115-L120)*)\
output:
```js
{
    id: 'solo-leveling',
    title: 'Solo Leveling',
    image: 'https://cdn.asurascans.com/asura-images/covers/solo-leveling.c27830.webp',
    cover: 'https://cdn.asurascans.com/asura-images/banners/solo-leveling.b0f7b9.webp',
    altTitles: [ '나 혼자만 레벨업', 'Only I Level Up', 'Ore dake Level Up na Ken', ... ],  // 30 of them
    status: 'Completed',
    authors: [ '추공 (Chugong)' ],
    artist: 'REDICE STUDIO',
    genres: [ 'Action', 'Adventure', 'Fantasy', 'Shounen' ],
    type: 'manhwa',
    rating: 9.77649837614408,
    bookmarkCount: 38432,
    popularityRank: 35,
    chapterCount: 201,
    updatedOn: '2024-07-13T02:15:04Z',
    url: 'https://asurascans.com/comics/solo-leveling-7e1f454a',
    headers: { 'User-Agent': '...', Referer: 'https://asurascans.com/' },
    description: '...',
    recommendations: [ { id: 'infinite-mage', title: 'Infinite Mage', ... }, {...} ],
    chapters: [
        {
          id: 'solo-leveling/chapter/200',
          title: 'Side Story 21 { THE END }',
          chapterNumber: '200',
          pages: 15,
          releaseDate: '2024-07-13T02:15:04Z',
          views: 65246,
          isLocked: false,
          isPremium: false,
          readable: true,
          externalUrl: null
        },
        {...},   // 201 in total, newest first
    ]
}
```

Unknown slugs **throw** (`HTTP 404: series not found`) rather than resolving with an empty object —
the fail-open behaviour of the old provider is gone.

<h4>Status values</h4>

Five real values are mapped, including `Hiatus` and `Axed` — together roughly 40% of the catalogue.
Anything that only handles Ongoing/Completed will mislabel a large slice of this site.

### fetchChapterPages

<h4>Parameters</h4>

| Parameter | Type     | Description                                                    |
| --------- | -------- | -------------------------------------------------------------- |
| chapterId | `string` | `'<slug>/chapter/<number>'` (*from the manga info*)             |

```ts
asuraScans.fetchChapterPages('solo-leveling/chapter/1').then(data => {
  console.log(data);
})
```
returns an array of pages. (*[`Promise<IMangaChapterPage[]>`](https://github.com/consumet/extensions/blob/master/src/models/types.ts#L122-L126)*)\
output:
```js
[
    {
        page: 1,
        img: 'https://cdn.asurascans.com/asura-images/chapters/solo-leveling/1/001.webp?v=1770499638',
        headers: { 'User-Agent': '...', Referer: 'https://asurascans.com/' }
    },
    {...},   // 22 pages
]
```

> **The chapter number stays a string, and can be fractional.** `'solo-leveling/chapter/0.5'` is a
> real chapter, and chapter `0` exists too. The chapter's own `slug` is **not** usable as an
> addressing key — it is a UUID on older series and `chapter-139` on newer ones — which is why the
> id is built from `number`.

<h4>Locked / early-access chapters</h4>

An early-access chapter answers **HTTP 200** with `is_locked: true`, `chapter.pages: null` and
`page_count: 0`, which maps naively to `[]` and a blank reader. Following the house convention set
on `mangadex`:

- `fetchChapterPages` **throws** a descriptive error naming the lock and its unlock time.
- `fetchMangaInfo` **pre-flags** those chapters up front, so a caller never has to reach the throw:
  `readable: false` plus `externalUrl` (the two fields `MangaAggregator` reads), alongside
  `isLocked` / `isPremium` / `unlockTime`. The aggregator maps `isLocked` to
  `unavailable.reason: 'locked'` and `isPremium` to `'premium'`, with `unlockTime` as the detail.

```js
{
  id: 'some-series/chapter/30',
  title: 'Chapter 30',
  chapterNumber: '30',
  pages: 0,
  isLocked: true,
  isPremium: true,
  unlockTime: '2026-08-15T00:05:48Z',
  readable: false,
  externalUrl: 'https://asurascans.com/comics/some-series/chapter/30'
}
```

Only `is_locked` gates `readable`. A chapter that is premium but *not* locked is left readable —
absence of evidence that it is gated is not evidence that it is.

<h4>Transport notes</h4>

- **One HTML fallback exists, for `fetchChapterPages` only.** `api.asurascans.com` is a bare
  unauthenticated subdomain — the first thing an operator firewalls — and with no pages the
  provider is worthless, whereas search and info merely degrade. The same page list is
  server-rendered into the chapter page's single `ChapterReader` `<astro-island>` and cannot be
  disabled without breaking the site. Both paths apply the lock check and both are covered by the
  offline suite. There is deliberately **no** fallback for search or info: the HTML there carries
  nothing the API does not, so a second unexercised path would be pure liability.
- **All three `asurascans` hosts share a User-Agent deny-list.** `Python-urllib/3.14` gets 403 from
  `api.`, `cdn.` and the HTML host, while an absent UA, `Consumet/1.0`, `axios/1.6.0` and Chrome
  all get 200. This is a library-UA deny-list, **not** the ComicK-style browser-UA trap, so the
  shared explicit `USER_AGENT` this provider sends on every request is fine.
- **`cdn.asurascans.com` has no hotlink protection.** Verified with a correct `Referer`, with none,
  and with a hostile `https://evil.example.com/`: byte-identical 200s (`image/webp`, RIFF/WEBP
  magic) every time. The `Referer` above is parity with sibling providers, not a requirement, and
  no server-side proxy hop is needed for images. The `?v=` suffix is decorative — stripping it
  returns byte-identical content. (Probed from a residential IP; re-confirm from your deployment
  host before relying on it.)

<p align="end">(<a href="https://github.com/consumet/extensions/blob/master/docs/guides/manga.md#">Back to Providers List</a>)</p>
