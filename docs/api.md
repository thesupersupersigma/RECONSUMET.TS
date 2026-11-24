# The HTTP API (`@reconsumet/api`) and its typed client (`@reconsumet/client`)

**In plain English:** the API is the service the site talks to. Ask it for an anime (by AniList ID), its episodes on a
source, or the playable streams of one episode. Stream answers never contain a third-party URL. Every video and
subtitle link points at **our relay** (see [relay.md](relay.md)) and carries a sealed, short-lived token. The API
keeps its data in Postgres (the catalog, AniList answers, which show on which site is which AniList entry, API keys,
source health), and runs the weekly/daily housekeeping jobs itself. The site uses `@reconsumet/client`, a typed
client generated from the API's own code, so the two can't drift apart.

## Routes

The full machine-readable contract is at **`/openapi.json`**, with a browsable UI at **`/docs`**.

| Route | Key needed | What it returns |
|---|---|---|
| `GET /v1/health` | no | `{ ok, version }` |
| `GET /v1/status` | no | today's AniList usage against the budgets, and whether AniSkip is on |
| `GET /v1/sources` | no | every source in preference order + its latest health check |
| `GET /v1/search?q=&limit=` | no | catalog entries (offline database + daily AniList sync), best match first |
| `GET /v1/anime/:anilistId` | no | AniList details for the anime and watch pages (below; fresh 24 h when finished, 1 h otherwise) |
| `GET /v1/anime/:anilistId/episodes?source=` | no | episodes on one source in **AniList numbering** (split-cour offsets applied), with AniList titles/thumbnails where it has them |
| `GET /v1/anime/:anilistId/episodes/:ep/skip?duration=` | no | opening/ending times from AniSkip (below) |
| `GET /v1/anime/:anilistId/episodes/:ep/streams?source=&audio=sub\|dub&viewerIp=` | **yes** | servers → streams + subtitles, every URL a relay URL |

Without `source`, the first source in preference order that has the show answers (Re:Anime, then AniZone).

`viewerIp` (key callers only): the site can pass the IP of the viewer it is serving. The relay then refuses that link
from any other address. Off by default: phones switching between Wi-Fi and mobile data change IP mid-episode.

### Anime details

One AniList request per anime (≈ 16 KB for a movie, 28 KB for Frieren, 66 KB for One Piece with its 65 relations;
measured 2026-11-24). Besides titles, format, dates, cover, next airing and relations, an answer has:

| Field | Notes |
|---|---|
| `description` | **AniList's HTML as given. Sanitize it before rendering** (it's third-party text). Can be null. |
| `bannerImage` | can be null |
| `coverImage` | `{ extraLarge, large, medium, color }`, each can be null; `color` is `#rrggbb` |
| `genres`, `tags` | tags: `{ name, rank, isSpoiler, isAdult }`; hide spoiler tags by default |
| `averageScore`, `meanScore`, `popularity`, `favourites` | numbers or null (scores are 0–100) |
| `studios` | `{ id, name, isAnimationStudio, isMain }`, main studios first |
| `source`, `countryOfOrigin`, `hashtag`, `siteUrl` | can be null |
| `isAdult` | boolean |
| `trailer` | `{ site: "youtube" \| "dailymotion", id, thumbnail }` or null |
| `characters` | first 12, MAIN first: `{ id, name, nameNative, image, role, voiceActor, voiceActorEnglish }`; the voice actors are `{ id, name, nameNative, image }` (Japanese / English) or null |
| `recommendations` | first 12 by rating: `{ id, title, format, episodes, averageScore, coverImage: { large } }` |
| `relations.edges[].node` | now also `coverImage: { large }` and `averageScore` |
| `externalLinks` | `{ site, url, type: INFO \| STREAMING \| SOCIAL, language }`, for "watch legally" links |
| `streamingEpisodes` | `{ title, thumbnail, url, site }` as AniList lists them (often Crunchyroll, not every episode) |

When AniList or the budget says no, the last answer is served even if it has expired (kept 30 days). Only when nothing
is cached is it a 503 `anilist_cap` (or 502 `anilist` if AniList itself failed).

### Episodes

Items are `{ number, title?, thumbnail?, sub?, dub? }`. `title` is the source's; when the source has none, AniList's
`streamingEpisodes` fill it in, matched by the number in their titles ("Episode 5 - …"; a number listed twice with
different titles is skipped). `thumbnail` comes from the same match. Nothing is made up: no match, no field.

### Skip times

`GET /v1/anime/:id/episodes/:ep/skip?duration=<seconds>` → `{ intro?: { start, end }, outro?: { start, end }, source:
"aniskip" | "none" }`. From [AniSkip](https://github.com/aniskip/aniskip-api) (third-party, crowd-sourced, by MAL ID).
`duration` is the length of the stream the viewer is playing: AniSkip only answers for an episode of about that
length, so the times fit that cut. `none` = no times, the anime has no MAL ID, or `ANISKIP_ENABLED=false`. Answers are
cached 7 days, misses 6 hours, per MAL ID + episode + rounded duration. Use it only when the stream's server has no
`intro`/`outro` of its own.

### A streams answer

```json
{
  "source": "reanime", "anilistId": 154587, "episode": 1, "sourceEpisode": 1, "audio": "sub",
  "expiresAt": "2026-11-24T13:52:00.000Z",
  "servers": [{
    "name": "HD-2 (FlixCloud)", "intro": { "start": 0, "end": 90 },
    "streams": [{ "url": "https://relay.example.com/r/AbC…xyz.m3u8", "type": "hls", "quality": "auto", "audioLang": "jpn" }],
    "subtitles": [{ "lang": "en", "label": "English", "format": "ass", "default": true,
                    "url": "https://relay.example.com/r/DeF…uvw.ass" }]
  }]
}
```

`expiresAt` only limits *starting* playback (default 10 minutes). Once the player has the playlist, the relay hands out
child links that last 6 hours, so a paused episode keeps working.

## Keys, limits, errors

- **API keys** are for server-to-server callers such as the site. Send `x-api-key: rk_…` (or `Authorization: Bearer
  rk_…`). Only a SHA-256 hash is stored. Create, list and revoke them with the CLI, or let the API create one from
  `API_BOOTSTRAP_KEY` (both below). A wrong or revoked key is
  always a 401, even on routes that don't need one.
- **Streams need a key** by default (`REQUIRE_KEY_FOR_STREAMS=true`), so nobody can use the API as a free video
  resolver. Metadata routes are open.
- **Rate limits**, in one-minute windows: per IP without a key (`RATE_LIMIT_IP_PER_MIN`, default 60), per key with one
  (`RATE_LIMIT_KEY_PER_MIN`, default 600, or the key's own limit). Answers carry `ratelimit-remaining` /
  `ratelimit-reset`, and a 429 adds `retry-after`. The client IP comes from `X-Forwarded-For` **only** when the direct
  peer is in `TRUSTED_PROXIES` (your reverse proxy or tunnel; `CLIENT_IP_HEADER` picks another header such as
  `CF-Connecting-IP`). Otherwise anyone could fake their way to a fresh limit. Limits are per process (fine for one instance).
- **Errors** always look like `{ "error": { "code": "…", "message": "…" } }`: `invalid_request` 400, `unknown_source`
  400, `bad_key` / `key_required` 401, `not_found` / `no_source` / `no_streams` 404, `rate_limited` 429, `anilist` 502,
  `aniskip` 502, `anilist_cap` 503 (an AniList budget is used up and nothing is cached), `internal` 500.
- `PUBLIC_URL` and `RELAY_PUBLIC_URL` come from config, never from the request's `Host` header (a v1 lesson).

## Jobs

Inside the API process, checked every 5 minutes. Each takes a Postgres advisory lock and runs only if its last
*successful* run is older than its interval, so two instances or a restart never run one twice. A failed run is
recorded in `job_runs` and retried at the next check.

| Job | Every | Does |
|---|---|---|
| `catalog-update` | 7 days | re-imports the anime offline database if a new release exists (41.5k entries ≈ 26 s on a 2010 Xeon) |
| `anilist-sync` | 1 day | airing + next season + recently updated from AniList (4 requests, from the sync's own budget) |
| `source-health` | 15 min | one health check per source, kept as history in `source_health` |
| `cache-prune` | 1 day | deletes expired cache rows |

`JOBS_ENABLED=false` turns them off (e.g. for a second instance).

## Database

Postgres via Drizzle ORM, schema + SQL migrations in `packages/db` (`drizzle/`). Tables: `catalog` (all cross-IDs
uniquely indexed, `pg_trgm` index for fuzzy title search), `catalog_meta`, `mappings`, `overrides`, `cache` (AniList
answers + short-lived stream/episode answers), `api_keys`, `source_health`, `job_runs`.
**Migrations run when the API starts**, under an advisory lock (two starting instances don't collide). They can also
be run by hand: `reconsumet-api migrate`. Tests use PGlite (Postgres compiled to WebAssembly), so no Docker is needed.

Manual mapping fixes go in the `overrides` table (`source_id`, `anilist_id`, `show_id` or NULL for "not on this
source", `episode_offset`, `episode_range`, `note`). The CLI still uses `data/overrides.json`.

## CLI (inside the API container: `node dist/cli.js …`)

```sh
reconsumet-api migrate                       # apply migrations
reconsumet-api keys create site 1200         # name + optional per-minute limit; prints the key ONCE
reconsumet-api keys list
reconsumet-api keys revoke 3
```

Or without any command: set `API_BOOTSTRAP_KEY` (at least 32 characters, e.g. `openssl rand -hex 32`) and the API
makes sure that key exists on every start (named `API_BOOTSTRAP_KEY_NAME`, default `bootstrap`, with
`API_BOOTSTRAP_KEY_RPM` requests/minute if set). Only its hash is stored and the value is never logged. If it already
exists nothing changes; a revoked bootstrap key stays revoked (to replace it, set a new value).

## The typed client

```ts
import { createClient, type StreamsT } from '@reconsumet/client'

const api = createClient(process.env.RECONSUMET_URL!, { apiKey: process.env.RECONSUMET_KEY })
const res = await api.v1.anime[':anilistId'].episodes[':episode'].streams.$get({
  param: { anilistId: '154587', episode: '1' },
  query: { audio: 'sub' },
})
if (res.ok) {
  const streams: StreamsT = await res.json()
}
```

`npm i @reconsumet/client` (its only dependency is `hono`). Routes, parameters and response types come from the API's
Hono app type, baked into the package's own `.d.ts` when it is built, so installing it never pulls in the server. It
exports types only (`CatalogEntryT`, `AnimeT`, `SourceT`, `EpisodesT`, `StreamsT`, `ApiError`, `ApiSchema`), no zod
schemas. Use the client version that matches the server. Use the key on the server only, never in the browser.

## Running it

`docker compose up -d` (Postgres + API + relay, see [self-hosting.md](self-hosting.md)), or against your own Postgres:
`pnpm dev` with `DATABASE_URL` and `RELAY_SECRET` in `.env`.
