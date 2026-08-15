<h1> Mangasee123 (WeebCentral) </h1>

```ts
const mangasee123 = new MANGA.Mangasee123();
```

> **The class name is historical.** `mangasee123.com` is a ParkLogic parked domain — every path,
> including deliberately bogus ones, answers HTTP 200 with the same ad interstitial, so a naive
> uptime check still calls it healthy. `manga4life.com` no longer resolves and `mangalife.us` is
> parked by the same operator. This provider now scrapes **weebcentral.com**, where the library
> moved (same cover CDN `temp.compsci88.com`, same page CDNs `*.lowee.us` / `*.planeptune.us`).
> The class name, `classPath` (`MANGA.Mangasee123`) and default export are unchanged so existing
> imports keep resolving; only the display `name` is now `WeebCentral`.

> **Every id changed shape and old ids are not convertible.** Ids are 26-character ULIDs
> (`01J76XYA2AFH8MNBG4FRCM5JMV`). Legacy slugs such as `Yofukashi-no-Uta` and
> `Yofukashi-no-Uta-chapter-1` do not exist on this site and are **rejected pre-flight** with an
> actionable message. Any stored or cached mangasee123 id anywhere in your stack is dead and must
> be re-resolved through `search()`.

<h2>Methods</h2>

- [search](#search)
- [fetchMangaInfo](#fetchmangainfo)
- [fetchChapterPages](#fetchchapterpages)

### search
> Note: This method is a subclass of the [`BaseParser`](https://github.com/consumet/extensions/blob/master/src/models/base-parser.ts) class, meaning it is available across most categories.

<h4>Parameters</h4>

| Parameter | Type     | Description                                                          |
| --------- | -------- | -------------------------------------------------------------------- |
| query     | `string` | query to search for. (*In this case, `Goodnight Punpun`*)             |
| page      | `number` | *optional* 1-based page. Paging is offset-based upstream.             |

> The upstream `/search/data` endpoint **ignores `limit` entirely** — it returns exactly 32 rows
> for every value tested (5, 10, 24, 32, 50, 100, 200). The page size is therefore pinned as a
> constant and is *not* caller-settable; passing a third argument does nothing. `hasNextPage` is
> read from the site's own load-more control rather than inferred from a row count.

```ts
mangasee123.search('punpun').then(data => {
  console.log(data);
})
```
returns a promise which resolves into an array of manga. (*[`Promise<ISearch<IMangaResult[]>>`](https://github.com/consumet/extensions/blob/master/src/models/types.ts#L97-L106)*)\
output:
```js
{
    currentPage: 1,
    hasNextPage: false,
    results: [
        {
        id: '01J76XYA2AFH8MNBG4FRCM5JMV',
        title: 'Goodnight Punpun',
        image: 'https://temp.compsci88.com/cover/normal/01J76XYA2AFH8MNBG4FRCM5JMV.webp',
        headerForImage: { Referer: 'https://weebcentral.com/' },
        releaseDate: '2007',   // a STRING, as everywhere else in this codebase
        status: 'Completed',
        authors: [ 'ASANO Inio' ],
        genres: [ 'Adult', 'Comedy', 'Drama', 'Psychological', 'Seinen', 'Slice of Life' ]
        },
        {...},
    ]
}
```

### fetchMangaInfo

<h4>Parameters</h4>

| Parameter | Type     | Description                                                                     |
| --------- | -------- | ------------------------------------------------------------------------------- |
| mangaId   | `string` | a bare ULID, `<ULID>/<Slug>`, or a full series URL — all normalise to the ULID.   |

```ts
mangasee123.fetchMangaInfo('01J76XYA2AFH8MNBG4FRCM5JMV').then(data => {
  console.log(data);
})
```
returns a promise which resolves into an manga info object (including the chapters). (*[`Promise<IMangaInfo>`](https://github.com/consumet/extensions/blob/master/src/models/types.ts#L115-L120)*)\
output:
```js
{
    id: '01J76XYA2AFH8MNBG4FRCM5JMV',
    title: 'Goodnight Punpun',
    image: 'https://temp.compsci88.com/cover/fallback/01J76XYA2AFH8MNBG4FRCM5JMV.jpg',
    headerForImage: { Referer: 'https://weebcentral.com/' },
    altTitles: [ 'Oyasumi Punpun' ],
    authors: [ 'ASANO Inio' ],
    genres: [ 'Adult', 'Comedy', 'Drama', 'Psychological', 'Seinen', 'Slice of Life' ],
    status: 'Completed',
    releaseDate: '2007',
    links: [
        'https://www.viz.com/goodnight-punpun',
        'https://anilist.co/manga/34632',
        'https://www.mangaupdates.com/series/a2xc67o'
    ],
    description: 'Meet Punpun Punyama. He’s an average kid in an average town...',
    chapters: [
        {
          id: '01J76XYYEXFBRNW7N9S5PWS845',
          title: 'Chapter 147',
          releaseDate: '2024-09-07T17:04:15.717Z'
        },
        {...},   // 147 in total
    ]
}
```

> The chapter list comes from the `/series/<ULID>/full-chapter-list` fragment, **not** the series
> page — the series page embeds only ~9 chapters behind a "Show All Chapters" button, so parsing it
> silently truncates a 147-chapter series to 9.

> Unlike `mangadex`, there is **no unreadable-chapter state to pre-flag**. WeebCentral exposes no
> availability field and every chapter sampled served images, so `readable` / `externalUrl` are
> deliberately left unset — `MangaAggregator` reads their absence as "available", which matches
> reality.

### fetchChapterPages

<h4>Parameters</h4>

| Parameter | Type     | Description                                    |
| --------- | -------- | ---------------------------------------------- |
| chapterId | `string` | chapter ULID (*from the manga info*)            |

```ts
mangasee123.fetchChapterPages('01J76XYYEVMT2GHCEHAESF4VGN').then(data => {
  console.log(data);
})
```
returns an array of pages. (*[`Promise<IMangaChapterPage[]>`](https://github.com/consumet/extensions/blob/master/src/models/types.ts#L122-L126)*)\
output:
```js
[
    {
        page: 1,
        img: 'https://official.lowee.us/manga/Oyasumi-Punpun/0001-001.png',
        headerForImage: { Referer: 'https://weebcentral.com/' }
    },
    {...},
]
```

Page image URLs are **read from the served `<img>` list, never constructed**: the CDN host varies
per series (`official.lowee.us` for Goodnight Punpun, `hot.planeptune.us` for One Piece — both
re-confirmed live 2026-08-14), so there is no host to pin and no filename scheme to rebuild. The
planeptune host has rotated before (it was `scans-hot.planeptune.us`), which is the whole reason
these URLs are read rather than built.

<h4>Two things worth knowing before you render these</h4>

- **The extension and the Content-Type both lie.** Page URLs end in `.png` and the CDN answers
  `Content-Type: image/png`, but the bytes are **JPEG** (`ffd8ffe0`/JFIF). Anything that picks a
  decoder or a cache key from the extension or the content-type will be wrong. Covers are honest
  (webp is webp, jpg is jpg); only the page images lie.
- **There is no hotlink protection.** Verified on two CDN hosts with a correct `Referer`, with none
  at all, and with a hostile `https://evil.example.com/` — byte-identical 200s every time. The
  `headerForImage` above is parity with sibling providers, not a requirement, and no server-side
  proxy hop is needed for images. (All probes were from a residential IP; re-confirm from your
  deployment host before relying on it.)

<h4>Failure modes</h4>

Unknown series ids 307 to `/404` and unknown or malformed chapter ids 307 to `/400` — and **both of
those destination pages answer HTTP 200**. Following the redirect would turn a garbage id into a
healthy-looking empty success, so requests suppress redirects and treat any 3xx as a hard, named
error. WeebCentral also 403s the axios default User-Agent (as it does `curl/` and a missing UA), so
an explicit User-Agent is mandatory and is always sent.

<p align="end">(<a href="https://github.com/consumet/extensions/blob/master/docs/guides/manga.md#">Back to Providers List</a>)</p>
