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
| query     | `string` | query to search for. (*In this case, We're searching for `Solo Leveling`*) |
| page      | `number` | *(optional)* 1-based page of results, 20 per page. Defaults to `1`. |

```ts
mangakakalot.search("Solo Leveling").then(data => {
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
  totalResults: 8,
  results: [
    {
      id: 'solo-leveling',
      title: 'Solo Leveling',
      image: 'https://img-r1.2xstorage.com/thumb/solo-leveling.webp',
      headerForImage: { Referer: 'https://www.manganato.gg/' }
    },
    {
      id: 'solo-leveling-ragnarok',
      title: 'Solo Leveling Ragnarok',
      approximateTitle: true,
      headerForImage: { Referer: 'https://www.manganato.gg/' }
    }
    {...}
    ...
  ]
}
```

> **Search is a slug index, not the site's search engine.** The site's own `/search/story/`
> endpoint is blocked (403 to every non-browser client, and disallowed in `robots.txt`), so results
> are ranked against the slugs advertised in the sitemap. Two consequences:
> - It matches on the URL slug, which encodes only ONE title. `"demon slayer"` will **not** find
>   `kimetsu-no-yaiba`, and `"shingeki no kyojin"` will not find `attack-on-titan`. There is no
>   fuzzy matching, so typos return nothing.
> - Results carrying `approximateTitle: true` had their title de-slugified from the URL, so
>   punctuation and capitalisation are approximations. Only an exact-slug top hit gets a real
>   title and cover. Treat approximate titles as low-confidence when matching against AniList/MAL.
>
> `clearSearchIndex()` drops the cached sitemap index (TTL 6h) for long-lived processes.

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
