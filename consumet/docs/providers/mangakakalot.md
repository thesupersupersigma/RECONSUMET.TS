<h1> MangaKakalot </h1>

```ts
const mangakakalot = new MANGA.MangaKakalot();
```

> **Host:** this provider now talks to `https://www.manganato.gg`. The original `mangakakalot.com`
> and `readmanganato.com` are both dead, and the `$$READMANGANATO` chapter-id suffix that used to
> pick between them is gone. Chapter ids are `<manga-slug>/<chapter-slug>`; an id in the old shape
> is rejected with an explicit error rather than silently fetching the wrong page, so any persisted
> ids must be re-fetched.

<h2>Methods</h2>

- [search](#search)
- [fetchMangaInfo](#fetchmangainfo)
- [fetchChapterPages](#fetchchapterpages)

### search
> Note: This method is a subclass of the [`BaseParser`](https://github.com/consumet/extensions/blob/master/src/models/base-parser.ts) class. meaning it is available across most categories.
> 
<h4>Parameters</h4>

| Parameter | Type     | Description                                                                  |
| --------- | -------- | ---------------------------------------------------------------------------- |
| query     | `string` | query to search for. (*In this case, We're searching for `Demon Slayer`*) |
| page      | `number` | *(optional)* 1-based page of results, 20 per page. Defaults to `1`. |

```ts
mangakakalot.search("Demon Slayer").then(data => {
  console.log(data);
})
```
returns a promise which resolves into an array of manga plus a `diagnostics` block. (*[`Promise<ISearch<IMangaResult[]>>`](https://github.com/consumet/extensions/blob/master/src/models/types.ts#L97-L106)*)\
output:
```js
{
  currentPage: 1,
  hasNextPage: false,
  totalPages: 1,
  totalResults: 10,
  results: [
    {
      id: 'kimetsu-no-yaiba',
      title: 'Kimetsu No Yaiba',
      image: 'https://img-r2.2xstorage.com/thumb/kimetsu-no-yaiba.webp',
      description: 'Tanjiro Kamado is a kindhearted boy...',
      matchedVia: 'alias-malsync',
      headerForImage: { Referer: 'https://www.manganato.gg/' }
    },
    {
      id: 'demon-slayer-kimetsu-academy',
      title: 'Demon Slayer Kimetsu Academy',
      approximateTitle: true,
      matchedVia: 'alias-anilist-title',
      headerForImage: { Referer: 'https://www.manganato.gg/' }
    },
    {
      id: 'demon-slayer-tanjiro-kanao-doujinshi',
      title: 'Demon Slayer Tanjiro Kanao Doujinshi',
      approximateTitle: true,
      matchedVia: 'slug-index',
      headerForImage: { Referer: 'https://www.manganato.gg/' }
    }
    {...}
    ...
  ],
  diagnostics: {
    strategy: [ 'alias-malsync', 'alias-anilist-title', 'slug-index' ],
    indexedSlugs: 93735,
    aliasBridgeRan: true,
    aliasCandidates: 6
  }
}
```

#### How search works, and what it cannot do

The site's own search API is **real but unreachable**. Its frontend (`/js/fsearch.js`) calls
`GET /home/search/json?searchword=<q>`, which `robots.txt` does not disallow — but that path and
`/search/story/` both answer `403` with `cf-mitigated: challenge` for every client tried (honest
and browser-claiming UAs, with and without `X-Requested-With`, GET and POST, on all four sibling
hosts). The block is **path**-scoped: `/manga/…`, `/api/manga/…` and `/manga-list/…` return `200`
on the same connection. Clearing a managed challenge needs a real browser, so search is answered
from two other corpora:

1. **A sitemap slug index** (~94k slugs, cached 6h) — the site's catalogue, keyed by *slug*.
2. **An alias bridge** — AniList synonyms plus MAL-Sync's exact MangaNato identifier. It runs
   **only** when the query is not already an exact slug, so common queries cost no off-site request.

The bridge is what makes cross-romanisation search work: `"demon slayer"` → AniList `87216` /
MAL `96792` → MAL-Sync's MangaNato identifier `kimetsu-no-yaiba`. `"shingeki no kyojin"` finds
`attack-on-titan` the same way. Without it the slug index answered `"demon slayer"` with nine
doujinshi and colour re-releases and never mentioned the real series.

**An alias is attested, then confirmed.** AniList and MAL-Sync only assert that a series exists and
what it is called; neither knows this site's stock. Every alias slug is checked against the sitemap
index, or (for at most 2 slugs the index does not list) by fetching `/manga/<slug>` and requiring a
`200`. Nothing unconfirmed is returned.

Remaining limits, stated plainly:
- **Series AniList does not carry** are unreachable — the bridge is only as broad as AniList's manga catalogue.
- **Typos** still fail: slug matching is substring/token containment with no edit distance.
- **No author, genre or description search.**
- Results flagged `approximateTitle: true` had their title de-slugified from the URL. Only the top
  hit is enriched from its real detail page. Treat approximate titles as low-confidence when
  matching against AniList/MAL.

Every result carries `matchedVia` (`alias-malsync` | `alias-anilist-title` | `slug-index` |
`slug-probe` | `browse-listing`).

> **Degraded answers are loud.** Any empty or degraded result set populates `diagnostics.warning`
> (and logs it), so `"the series is absent"` is always distinguishable from `"the sitemap was
> unreachable"` or `"AniList rate-limited us"` — a bare `[]` never has to be interpreted.

Set `useAliasResolution = false` to switch the bridge off entirely (no AniList/MAL-Sync request on
any path); search is then the slug index alone, and every non-exact query says so in
`diagnostics.warning`. `clearSearchIndex()` drops the cached sitemap index **and** the alias cache.

### fetchMangaInfo

<h4>Parameters</h4>

| Parameter | Type     | Description                                                    |
| --------- | -------- | -------------------------------------------------------------- |
| mangaId   | `string` | manga id.(*manga id can be found in the manga search results*) |

```ts
mangakakalot.fetchMangaInfo("solo-leveling").then(data => {
  console.log(data);
})
```
returns a promise which resolves into an manga info object (including the chapters). (*[`Promise<IMangaInfo>`](https://github.com/consumet/extensions/blob/master/src/models/types.ts#L115-L120)*)\
output:
```js
{
  id: 'solo-leveling',
  title: 'Solo Leveling',
  headerForImage: { Referer: 'https://www.manganato.gg/' },
  image: 'https://img-r1.2xstorage.com/thumb/solo-leveling.webp',
  authors: [ 'Chugong', 'Sung-rak Jang', 'Disciples' ],
  genres: [ 'Fantasy', 'Action', 'Adventure', 'Shounen', 'Webtoons' ],
  status: 'Completed',
  views: 1025569062,
  updatedAt: 'Sep-20-2025 11:03:43 AM',
  rating: 4.6,
  description: `Sung Jinwoo, also known as "the weakest hunter of all mankind," resides in a world full of awakened beings known as "Hunters"....`,
  chapters: [
    {
      id: 'solo-leveling/chapter-200',
      title: 'Chapter 200',
      url: 'https://www.manganato.gg/manga/solo-leveling/chapter-200',
      chapterNumber: 200,
      views: 946626,
      releasedDate: '2025-09-20T11:03:09.000000Z'
    },
    {...}
  ]
}
```
Note: The `headerForImage` property might be useful when getting the image to display.

> The detail page no longer server-renders its chapter list — it lazy-loads a paginated JSON API,
> which this method follows to completion. Chapters come back newest-first.

### fetchChapterPages

<h4>Parameters</h4>

| Parameter | Type     | Description                                              |
| --------- | -------- | -------------------------------------------------------- |
| chapterId | `string` | chapter id.(*chapter id can be found in the manga info*) |

```ts
mangakakalot.fetchChapterPages("solo-leveling/chapter-200").then(data => {
  console.log(data);
})
```
returns an array of pages. (*[`Promise<IMangaChapterPage[]>`](https://github.com/consumet/extensions/blob/master/src/models/types.ts#L122-L126)*)\
output:
```js
[
  {
    img: 'https://img-r1.2xstorage.com/solo-leveling/200/0.webp',
    page: 0,
    title: 'Solo Leveling Chapter 200 page 1',
    headerForImage: { Referer: 'https://www.manganato.gg/' }
  },
  {
    img: 'https://img-r1.2xstorage.com/solo-leveling/200/1.webp',
    page: 1,
    title: 'Solo Leveling Chapter 200 page 2',
    headerForImage: { Referer: 'https://www.manganato.gg/' }
  },
  {...}
]
```

> **The trailing slash in the Referer is load-bearing.** The image CDN answers `403` with a
> Cloudflare block page for a bare `https://www.manganato.gg` (no slash), for the real chapter URL,
> and for no Referer at all. Forward `headerForImage` verbatim.

<p align="end">(<a href="https://github.com/consumet/extensions/blob/master/docs/guides/manga.md#">back to manga providers list</a>)</p>
