# Task 06 — full anime details, episode extras, AniSkip, AniList budget (v0.6.0)

## Summary

The API now has everything the new anime page and watch page need, in **one AniList request per anime**:
description, banner, big cover with its colour, genres, tags, scores, studios, trailer, 12 main characters with their
Japanese and English voice actors, 12 recommendations, posters on related shows, "watch legally" links, and AniList's
per-episode titles and thumbnails. All of it was added to the existing routes. Nothing that existed changed shape, so
older sites keep working.

The episodes list now shows a thumbnail for each episode when AniList has one. When the source gives no episode title,
the title comes from AniList (Frieren: all 28 episodes get both). Nothing is made up. If the episode numbers don't
match cleanly, the field is left out.

A new route returns **opening/ending skip times** from AniSkip, a free third-party service. You need the length of
the stream being played, because AniSkip only answers for an episode of that length. It can be turned off with
`ANISKIP_ENABLED=false`.

**AniList can no longer take the anime page down.** Page lookups now have their own budget: 20 a minute and 3000 a
day, up from one shared 300/day. The daily sync has a separate small budget. When AniList is down, rate-limits us, or
the budget runs out, the API serves the last answer it had, even an old one. It only errors when it has never seen
that anime. Ten people opening the same new anime at once cause one AniList request. `GET /v1/status` shows today's
usage.

Search results now carry `isAdult`, so the site can hide adult titles. This needed one new database column, added
automatically on start.

Checked on **the PC (Windows 10)**: lint, typecheck, build, all tests (core 169, relay 24, db 12, api 18, client 1), the
new live tests (5/5 against real AniList, AniSkip and the sources), `pnpm test:pack` and
`node scripts/publish-npm.mjs --dry-run` (both packages at 0.6.0: "dry run ok"). Checked on **tsss-server** (the PC has
no Docker): both images build, and the API image started against a real Postgres 17. It ran the new migration
(`catalog.is_adult` exists) and answered `/v1/status`, `/v1/anime/154587` (200, 24 KB) and a skip-times call with real
AniSkip data. Everything was removed afterwards (see the note in "Notes and risks" about the build cache).

## New fields (`GET /v1/anime/:anilistId`)

Trimmed real answer (Frieren, 154587):

```json
{
  "id": 154587, "idMal": 52991,
  "title": { "romaji": "Sousou no Frieren", "english": "Frieren: Beyond Journey’s End", "native": "葬送のフリーレン" },
  "format": "TV", "episodes": 28, "status": "FINISHED", "season": "FALL", "seasonYear": 2023, "duration": 24,
  "startDate": { "year": 2023, "month": 9, "day": 29 }, "endDate": { "year": 2024, "month": 3, "day": 22 },
  "coverImage": { "extraLarge": "https://s4.anilist.co/…/bx154587-….jpg", "large": "…", "medium": "…", "color": "#bbf1a1" },
  "bannerImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587-….jpg",
  "description": "The adventure is over but life goes on for an elf mage just …<br><br>
(Source: Crunchyroll)",
  "genres": ["Adventure", "Drama", "Fantasy"],
  "tags": [{ "name": "Travel", "rank": 96, "isSpoiler": false, "isAdult": false }, "…"],
  "averageScore": 90, "meanScore": 90, "popularity": 501920, "favourites": 57272,
  "studios": [{ "id": 11, "name": "MADHOUSE", "isAnimationStudio": true, "isMain": true },
              { "id": 245, "name": "Toho", "isAnimationStudio": false, "isMain": false }, "…"],
  "source": "MANGA", "countryOfOrigin": "JP", "isAdult": false, "hashtag": "#フリーレン #frieren",
  "siteUrl": "https://anilist.co/anime/154587",
  "trailer": { "site": "youtube", "id": "tR8YH0G67Rk", "thumbnail": "https://i.ytimg.com/vi/tR8YH0G67Rk/hqdefault.jpg" },
  "characters": [{
    "id": 176754, "name": "Frieren", "nameNative": "フリーレン", "image": "https://s4.anilist.co/…/b176754-….png",
    "role": "MAIN",
    "voiceActor": { "id": 112215, "name": "Atsumi Tanezaki", "nameNative": "種﨑敦美", "image": "…" },
    "voiceActorEnglish": { "id": 119697, "name": "Mallorie Rodak", "nameNative": null, "image": "…" }
  }, "… 12 in all"],
  "recommendations": [{ "id": 21827, "title": { "romaji": "…" }, "format": "TV", "episodes": 13, "averageScore": 85,
                        "coverImage": { "large": "…" } }, "… 12"],
  "relations": { "edges": [{ "relationType": "SEQUEL", "node": { "id": 182255, "type": "ANIME", "format": "TV",
    "episodes": 10, "status": "FINISHED", "seasonYear": 2026,
    "title": { "romaji": "Sousou no Frieren 2nd Season", "…": "…" }, "coverImage": { "large": "…" }, "averageScore": 87 } }, "…"] },
  "externalLinks": [{ "site": "Official Site", "url": "https://frieren-anime.jp/", "type": "INFO", "language": "Japanese" },
                    { "site": "Twitter", "url": "…", "type": "SOCIAL", "language": "Japanese" },
                    { "site": "Crunchyroll", "url": "https://www.crunchyroll.com/series/GG5H5XQX4/…", "type": "STREAMING", "language": null }, "…"],
  "streamingEpisodes": [{ "title": "Episode 1 - The Journey's End", "thumbnail": "https://img1.ak.crunchyroll.com/…",
                          "url": "http://www.crunchyroll.com/watch/…", "site": "Crunchyroll" }, "…"],
  "nextAiringEpisode": null
}
```

(Values from the recorded fixture, 2026-11-24; long strings shortened with …)

**Response sizes** (uncompressed JSON, 2026-11-24): Kimi no Na wa. (movie) **15.8 KB**, Frieren **24.5 KB**, One Piece
**66 KB** (65 relation entries make up most of it, then ~70 streaming episodes). Characters and recommendations are
capped at 12 each, and each character keeps only its first Japanese and first English voice actor. One Piece's raw
AniList answer was 79 KB before that.

**Query cost:** the whole thing is one GraphQL request. It ran without complexity errors for One Piece, Frieren, Death
Note, the movie, and the top trending airing show. No second request was needed.

**Mapping:** studios, characters and recommendations are flattened from AniList's `edges/nodes` into simple lists (the
unit tests cover that). Everything else is AniList's own shape and names. `tags[].isSpoiler` is AniList's
`isMediaSpoiler`, because there's no plain `isSpoiler`.

## Episode extras (`GET /v1/anime/:id/episodes`)

Items gain optional `thumbnail`. `title` falls back to AniList's `streamingEpisodes` when the source has none. They
are matched by the number in AniList's title ("Episode 5 - …"). A number that shows up twice with different titles is
dropped as ambiguous. AniList's list is often partial (One Piece: only episodes 62–130). If AniList fails, the episode
list still comes back, just without extras.

**`aired` was not added.** The only way without extra requests is AniList's `airingSchedule` in the same query. That
returns 25 entries per page, so long shows would get dates for some episodes and not others. Better none than wrong.

## AniSkip

- Route: `GET /v1/anime/:anilistId/episodes/:ep/skip?duration=<seconds>` →
  `{ intro?: {start,end}, outro?: {start,end}, source: "aniskip" | "none" }`.
- Calls `GET {ANISKIP_URL}/v2/skip-times/{malId}/{ep}?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed&episodeLength={rounded duration}`
  through the normal fetcher (SSRF guard, retries, timeouts). `op` wins over `mixed-op`, `ed` over `mixed-ed`.
  `recap` isn't requested.
- **`duration` matters:** AniSkip matches the episode length. Frieren episode 3 is found at 1470 s and *not* at 1440 s
  (checked live). So the site must send the real stream length from the player, not AniList's 24 minutes.
- Cache: found 7 days, miss 6 hours (new episodes get times submitted after airing), keyed by MAL ID + episode +
  rounded seconds, in the Postgres cache table (`ns = 'aniskip'`).
- No MAL ID → `none`. `ANISKIP_ENABLED=false` → always `none` and no outside request. AniSkip errors (not a 404) →
  502 `aniskip`, not cached.
- Credited in the README's data attribution as a third-party service.

## AniList budget

| Budget | Default | Env | Why |
|---|---|---|---|
| page lookups / minute | **20** | `RECONSUMET_ANILIST_PER_MIN` | AniList allows 30/min per IP right now (90 normally). 20 leaves room for the sync and retries. |
| page lookups / UTC day | **3000** | `RECONSUMET_ANILIST_DAILY_CAP` | A details answer stays fresh 1–24 h, so this is about 3000 *different* anime a day. Repeat views are cache hits. |
| sync / UTC day | 20 (fixed) | — | The sync needs 4. Its own budget means it can't eat the page budget, and a bug in it can't either. |

- AniList's `X-RateLimit-Remaining` ≤ 1 or a 429 pauses **everyone** until `X-RateLimit-Reset` / `Retry-After`.
  During a pause, page lookups don't wait: they serve the cached answer or fail fast. The sync waits, as before. Page
  lookups also stop retrying after 5 s instead of 65 s, so a viewer never sits through a minute-long Retry-After.
- **Stale beats error:** details are stored with a "fresh until" time and kept 30 days. Inside that window an
  AniList failure (cap, per-minute, pause, 5xx, network) serves the old answer. The next lookup tries AniList again.
  `503 anilist_cap` only when nothing is cached.
- **One request per anime at a time:** concurrent lookups of the same ID share one in-flight request.
- `GET /v1/status` → `{ version, anilist: { day, count, cap, lastMinute, perMinute, sync: { count, cap },
  pausedUntil }, aniskip }`. It's a new route because `/v1/health` stays free of database reads (it's the container
  health check).
- Docs: docs/catalog.md (why, how to tune, AniList's terms), docs/self-hosting.md and .env.example (the env vars),
  docs/api.md (fields, errors, skip route).
- There is no "search fallback" to AniList in the API today: `/v1/search` only reads the local catalog. The budget
  applies to `anilist.search()` too, for library/CLI users.

## Small fixes

- `fix(api): suggest hex secrets in the bootstrap key error` committed first, as asked.
- `isAdult` on catalog entries: from AniList's `isAdult` (daily sync) and from the offline database's `hentai` tag
  (import). New nullable column `catalog.is_adult` (migration `0002_catalog_is_adult`). `/v1/search` returns it when
  known. **Existing installs:** the weekly import skips an unchanged offline-database release, so imported entries get
  `isAdult` with the next release (weekly). Until then it's absent ("unknown"), except on synced entries.

## Tests (machine: the PC, Windows 10, Node 26.4; Docker parts on tsss-server)

| Check | Result |
|---|---|
| `pnpm lint` (biome) | clean, 122 files |
| `pnpm typecheck`, `pnpm build` | ok |
| `pnpm test` | core 169, relay 24, db 12, api 18, client 1: all passed |
| `test:live` (new `packages/api/test/details.live.test.ts`) | 5/5: One Piece, Kimi no Na wa., top trending airing show, Frieren episodes with thumbnails, Death Note ep 1 skip times (+ a miss at a wrong length) |
| `pnpm test:pack` | ok: client 0.6.0 installs alone (`@reconsumet`, `hono`, `typescript`); new `AnimeT` fields and `SkipT` are typed; wrong fields fail |
| `node scripts/publish-npm.mjs --dry-run` | `@reconsumet/core@0.6.0` and `@reconsumet/client@0.6.0`: dry run ok. Run on a temporary local commit that was then `git reset --soft`, because the script needs a clean tree and the report had to come before the release commit. |
| npm tarball | no fixtures or tests inside `@reconsumet/core` |
| Docker (tsss-server) | `api` and `relay` targets build; API image migrates a fresh Postgres 17 and answers `/v1/status`, details, skip |

The other existing live suites (golden set, sources, end-to-end relay, Postgres) were **not** re-run. The golden live
test only got `perMinute: 1000` so the new 20/min budget doesn't trip it (the fetcher's host rule still paces it at
1 request / 2 s).

New unit tests: the details mapping (recorded Frieren answer), stale fallback (AniList 500, daily cap, nothing cached),
per-minute budget, shared in-flight request, global back-off on `X-RateLimit-Remaining` and on 429 (page lookups fail
fast, the sync waits), the sync's own budget, `streamingEpisodeExtras` (incl. ambiguous numbers), AniSkip (mapping,
URL, rounded-duration cache, cached misses, errors), API routes (details, episode extras, skip with / without MAL ID /
disabled / bad duration, `/v1/status`, `isAdult` in search) and the typed client. Fixtures: AniList's public answer
for Frieren and two AniSkip answers (public, crowd-sourced data; no personal data).

## Commits

| Commit | |
|---|---|
| `0398d7c` | fix(api): suggest hex secrets in the bootstrap key error |
| `33ad856` | feat(catalog): isAdult on catalog entries for hiding adult titles |
| `0329244` | feat(anilist): full anime details, two request budgets, stale answers on errors |
| `3b71c3e` | feat(core): AniSkip skip-times client |
| `95d1cac` | feat(api): anime page fields, episode thumbnails, skip route, /v1/status |
| `f6ed691` | docs: anime details, skip times, AniList budgets |
| (next) | docs: task 06 report |
| (last) | chore(release): 0.6.0, tag `v0.6.0` |

## Push

```sh
cd ~/Desktop/project5/animeSite/RECONSUMET.TS
git push origin master
git push origin v0.6.0
```

Pushing the tag starts `release.yml`. It publishes **`@reconsumet/core@0.6.0` and `@reconsumet/client@0.6.0` to npm**
through trusted publishing (the first real run of that path) and the images
`ghcr.io/thesupersupersigma/reconsumet-api:0.6.0` / `reconsumet-relay:0.6.0` (+ `latest`) to GHCR. Push master first
so the tag's commit is already on GitHub.

How to check:
- GitHub → Actions → the `v0.6.0` run: both jobs green. The npm job log ends with `published` for each package.
- `npm view @reconsumet/core version` and `npm view @reconsumet/client version` → `0.6.0`. On npmjs.com each package
  page shows a provenance badge ("Built and signed on GitHub Actions").
- `docker pull ghcr.io/thesupersupersigma/reconsumet-api:0.6.0` (and `-relay`), or GitHub → Packages.
- If the npm job fails with a 404/403 on publish, the trusted publisher on npmjs.com isn't set up for that package
  (04.2 report, step 4). Fix it and re-run the job; versions already published are skipped.

Note: the task speaks of "0.5.0 sites", but this repo went 0.4.2 → 0.6.0. There was no RECONSUMΣT.TS 0.5.0 release.
The compatibility promise holds against 0.4.2.

## Suggested `brainstorm.md` edits

- **1.24 (AniList):** replace "one daily cap of 300" with the two budgets: page lookups 20/min + 3000/day
  (`RECONSUMET_ANILIST_PER_MIN`, `RECONSUMET_ANILIST_DAILY_CAP`), the sync its own 20/day. Add: global back-off on
  `X-RateLimit-Remaining`/429, stale answers served for up to 30 days when AniList or a budget says no, concurrent
  lookups share one request, `/v1/status` shows usage.
- **1.24:** details are one GraphQL request (measured: fits the complexity limit; ≤ 66 KB for the biggest show tried).
- **1.32 (milestone 0.6):** done: details for anime/watch pages, episode thumbnails/titles from `streamingEpisodes`,
  AniSkip skip route, AniList budgets, `isAdult` in search. Not done: `aired` per episode (no complete source without
  extra requests).
- **Third-party services:** add AniSkip (optional, `ANISKIP_ENABLED`, `ANISKIP_URL`) next to AniList and the offline
  database.

## For the site task

- **Client:** `@reconsumet/client@^0.6.0`. New types: `SkipT`, `StatusT`. `AnimeT` carries every new field.
- **Details** (`api.v1.anime[':anilistId'].$get({ param: { anilistId } })`):
  - Always present (may be empty lists): `genres`, `tags`, `studios`, `characters`, `recommendations`,
    `externalLinks`, `streamingEpisodes`, `relations.edges`, `isAdult`, `coverImage` (the object itself).
  - **Can be null:** `description`, `bannerImage`, every `coverImage.*` incl. `color`, `averageScore`, `meanScore`,
    `popularity`, `favourites`, `source`, `countryOfOrigin`, `hashtag`, `siteUrl`, `trailer`, `nextAiringEpisode`,
    `idMal`, `title.english/native`, a character's `image`/`nameNative`, `voiceActor`, `voiceActorEnglish`,
    recommendation/relation `coverImage` and `averageScore`, `episodes`, `format`, `startDate.*`/`endDate.*`.
  - **`description` is AniList HTML (`<br>`, `<i>`, …): sanitize it** (allow-list a few inline tags) before rendering.
  - Hide `tags` with `isSpoiler: true` by default, and tags with `isAdult: true` unless the viewer opted in.
  - Trailer: `site === 'youtube'` → `https://www.youtube-nocookie.com/embed/${id}`; `dailymotion` →
    `https://www.dailymotion.com/embed/video/${id}`.
  - "Watch legally": `externalLinks.filter(l => l.type === 'STREAMING')`, plus the `INFO` link with
    `site === 'Official Site'`.
  - 503 `anilist_cap` means "AniList budget used and never seen this anime": show a "try again in a minute" state, not
    a 404.
- **Episodes:** `{ number, title?, thumbnail?, sub?, dub? }`. A missing `thumbnail` is normal. Fall back to the
  banner or cover.
- **Skip times:** only when the chosen server has no `intro`/`outro` of its own. Once the player knows the media
  duration (`loadedmetadata`):
  ```ts
  const r = await api.v1.anime[':anilistId'].episodes[':episode'].skip.$get({
    param: { anilistId: String(id), episode: String(ep) },
    query: { duration: String(Math.round(video.duration)) },
  })
  if (r.ok) { const s = await r.json(); if (s.source === 'aniskip') { s.intro; s.outro } }
  ```
  Treat any non-200 as "no skip times". The route needs no API key (so the browser may call it directly through the
  site's proxy, or the site's server can). Times are seconds from the start of that stream.
- **Search:** entries may carry `isAdult`. Hide `isAdult === true` by default. Absent means unknown, so show those.
- **Status:** `GET /v1/status` is handy for an admin page. No key needed.

## Notes and risks

- The per-minute counter lives in each API process's memory. The daily counters are shared through Postgres, but they
  are read-then-written, so two API instances can overshoot a little (same as before).
- Old `media:<id>` cache rows from 0.4.x are no longer read (new key `details:<id>`). They expire within a day and the
  daily prune deletes them. The first view of each anime after the upgrade costs one AniList request.
- On tsss-server I ran `docker builder prune -f` while cleaning up. That cleared **all** Docker build cache on that
  machine, not just this task's. It's only a cache, but the next image build there starts cold.
- AniSkip is crowd-sourced. Times can be missing or a few seconds off, and the site should keep the skip button
  optional.
