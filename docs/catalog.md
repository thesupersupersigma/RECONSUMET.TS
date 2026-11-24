# The anime catalog and the AniList client (`@reconsumet/core`)

**In plain English:** RECONSUMΣT.TS keeps its own list of every anime (about 41,500 of them) so it knows each show's
titles, alternative names, year, type and episode count without asking AniList every time. The list comes from the
free **anime-offline-database** project and is refreshed weekly. Because that file is updated only every few months,
a small daily AniList query adds this season's and next season's shows. AniList is otherwise used only for single
lookups (one show's details and its sequels/prequels), with a cache, a daily request cap, and their rate limit
respected. Its terms forbid bulk downloading, so we never page through all of AniList.

## Data source and license

The catalog is **derived from [manami-project/anime-offline-database](https://github.com/manami-project/anime-offline-database)**,
made available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/); its
contents are under the [Database Contents License (DbCL) 1.0](https://opendatacommons.org/licenses/dbcl/1-0/).
RECONSUMΣT.TS downloads the release file and converts it (`normalizeManami`); the converted catalog in your data dir
is a derived database under the same terms. If you publish it (or a database built from it), you must keep this
attribution and offer it under the ODbL. Entries added by the AniList sync come from [AniList](https://anilist.co)
under AniList's API terms.

## Commands

```sh
pnpm reconsumet catalog update            # weekly: skips the 60 MB download when the release is unchanged
pnpm reconsumet catalog update --force    # re-import anyway
pnpm reconsumet anilist sync              # daily: airing + next season + recently updated (4 AniList requests)
pnpm reconsumet catalog search frieren
```

Everything lives in the **data dir**: `RECONSUMET_DATA_DIR`, default `./data` (gitignored).

| file | what |
|---|---|
| `catalog.json` | the catalog (~18 MB) + import metadata (ETag, `lastUpdate`) |
| `cache/anilist/` | AniList responses, one file per query, with an expiry |
| `anilist-usage.json` | AniList requests made today (UTC) |
| `mappings.json`, `overrides.json` | AniList → source mappings (see [sources.md](sources.md)) |

## Catalog entries

`{ anilistId?, malId?, kitsuId?, anidbId?, title, synonyms[], type, episodes, status, season, year, picture, duration }`.
Entries without an AniList ID are kept: their MAL/AniDB IDs and AniDB-style titles still help matching.
`type` is TV / MOVIE / OVA / ONA / SPECIAL / UNKNOWN; `status` FINISHED / ONGOING / UPCOMING / UNKNOWN (AniList's
TV_SHORT, RELEASING, NOT_YET_RELEASED… are mapped onto these); `duration` is seconds per episode; `episodes` 0 = unknown.

## `CatalogStore`

```ts
interface CatalogStore {
  get(ref: { anilistId?, malId?, kitsuId?, anidbId? }): Promise<CatalogEntry | undefined>
  search(query: string, limit?: number): Promise<CatalogEntry[]>   // titles + synonyms, normalized
  upsert(entries: CatalogEntry[]): Promise<void>                     // merge on any shared ID; synonyms unioned
  listAiring(): Promise<CatalogEntry[]>
  count(): Promise<number>
  getMeta<T>(key: string): Promise<T | undefined>
  setMeta(key: string, value: unknown): Promise<void>
}
```

0.3 ships `FileCatalogStore` (one JSON file, all in memory). 0.4 adds a Postgres implementation: each method is one
query (ID columns, a trigram title index, `INSERT … ON CONFLICT`, a key/value table).

**Update check:** `updateOfflineDb()` sends `If-None-Match` with the stored ETag (GitHub's release asset is an Azure
blob that answers 304). If a server ignores that, the file's own `lastUpdate` is compared before importing.

## AniList client

```ts
const anilist = createAniList({ fetcher, dir: dataDir() })
await anilist.media(119661)        // titles, synonyms, format, episodes, dates, status, relations, MAL ID, next airing
await anilist.search('frieren')
await anilist.sync(catalogStore)   // the small sync
await anilist.usage()              // { day, count, cap }
```

- Goes through the fetcher's `plain` tier; host rule `ANILIST_HOST_RULE` = 1 request per 2 s (AniList's current limit
  is 30/minute). Queries are POSTs but read-only, so they're retried, honouring `Retry-After` on 429.
- When `X-RateLimit-Remaining` reaches 1, the next call waits until `X-RateLimit-Reset`.
- **Daily cap:** `RECONSUMET_ANILIST_DAILY_CAP` (default 300) requests per UTC day; cache hits don't count. Past it,
  calls throw `AniListCapError`.
- **Cache:** `media` 24 h when the show is finished, 1 h otherwise (a "not found" is cached too); `search` 6 h.
- **Sync:** 2 pages of currently airing + 1 page of next season + 1 page of recently updated, 50 per page, merged
  into the catalog. That's 4 requests a day.
