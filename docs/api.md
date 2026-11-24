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
| `GET /v1/sources` | no | every source in preference order + its latest health check |
| `GET /v1/search?q=&limit=` | no | catalog entries (offline database + daily AniList sync), best match first |
| `GET /v1/anime/:anilistId` | no | AniList details incl. relations (cached 24 h when finished, 1 h otherwise) |
| `GET /v1/anime/:anilistId/episodes?source=` | no | episodes on one source in **AniList numbering** (split-cour offsets applied) |
| `GET /v1/anime/:anilistId/episodes/:ep/streams?source=&audio=sub\|dub&viewerIp=` | **yes** | servers → streams + subtitles, every URL a relay URL |

Without `source`, the first source in preference order that has the show answers (Re:Anime, then AniZone).

`viewerIp` (key callers only): the site can pass the IP of the viewer it is serving. The relay then refuses that link
from any other address. Off by default: phones switching between Wi-Fi and mobile data change IP mid-episode.

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
  rk_…`). Only a SHA-256 hash is stored. Create, list and revoke them with the CLI (below). A wrong or revoked key is
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
  `anilist_cap` 503 (the daily AniList cap is used up), `internal` 500.
- `PUBLIC_URL` and `RELAY_PUBLIC_URL` come from config, never from the request's `Host` header (a v1 lesson).

## Jobs

Inside the API process, checked every 5 minutes. Each takes a Postgres advisory lock and runs only if its last
*successful* run is older than its interval, so two instances or a restart never run one twice. A failed run is
recorded in `job_runs` and retried at the next check.

| Job | Every | Does |
|---|---|---|
| `catalog-update` | 7 days | re-imports the anime offline database if a new release exists (41.5k entries ≈ 26 s on a 2010 Xeon) |
| `anilist-sync` | 1 day | airing + next season + recently updated from AniList (4 requests, under the daily cap) |
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

Routes, parameters and response types come from the API's Hono app type. The zod schemas (`StreamsSchema`, …) are
re-exported for runtime validation. Use the key on the server only, never in the browser.

## Running it

`docker compose up -d` (Postgres + API + relay, see [self-hosting.md](self-hosting.md)), or against your own Postgres:
`pnpm dev` with `DATABASE_URL` and `RELAY_SECRET` in `.env`.
