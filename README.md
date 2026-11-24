<p align="center">
  <img src="RECONSUM%CE%A3T-TS.png" alt="RECONSUMΣT.TS" width="640">
</p>

<p align="center">
  <a href="https://discord.gg/trvtVNWzaf"><img src="https://img.shields.io/badge/discord-join-5865F2" alt="Discord"></a>
  <img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="License: GPL-3.0-or-later">
  <img src="https://img.shields.io/badge/version-0.4.1-orange" alt="Version 0.4.1">
</p>

# RECONSUMΣT.TS — v2 (rewrite in progress)

A self-hostable anime aggregator: a TypeScript scraping library plus an HTTP API with a built-in HLS + subtitle proxy.
It turns an AniList ID and an episode number into playable streams from whichever sources currently work.

**Status: v0.4.1 — API + relay, self-hostable by anyone.** v2 is being rewritten from scratch. RECONSUMΣT.TS is now a service: an HTTP API
(Hono, OpenAPI at `/docs`, API keys, rate limits, scheduled jobs, Postgres) that turns an AniList ID + episode number into
streams from **Re:Anime** and **AniZone**, and a separate **video relay** that serves every playlist, segment and
subtitle behind sealed, short-lived links ([docs/api.md](docs/api.md), [docs/relay.md](docs/relay.md),
[docs/self-hosting.md](docs/self-hosting.md)). Underneath: the sources and season mapping ([docs/sources.md](docs/sources.md)), the
anime catalog + AniList client ([docs/catalog.md](docs/catalog.md)) and the fetch layer ([docs/fetch.md](docs/fetch.md),
[docs/tls-bakeoff.md](docs/tls-bakeoff.md)).

| Package | What |
|---|---|
| `@reconsumet/core` | library: fetch layer, catalog, AniList client, sources, matching, relay tokens |
| `@reconsumet/db` | Postgres schema, migrations and stores (Drizzle) |
| `@reconsumet/api` | the HTTP API + jobs (Docker target `api`) |
| `@reconsumet/relay` | the video/subtitle relay (Docker target `relay`) |
| `@reconsumet/client` | typed API client for the site |

The previous version (v1, June–August 2026) is kept on the [`old`](../../tree/old) branch.

## Self-hosting

Anyone can run it: a Linux machine (x86-64 or arm64) with Docker and the Compose plugin. Video goes out through your
upload, so that decides how many can watch at once.

```sh
git clone https://github.com/thesupersupersigma/RECONSUMET.TS.git && cd RECONSUMET.TS
cp .env.example .env                 # set POSTGRES_PASSWORD and RELAY_SECRET (openssl rand -base64 32)
docker compose up -d                 # Postgres + API + relay; add --profile caddy for automatic HTTPS
curl http://localhost:8080/v1/health # API docs: http://localhost:8080/docs
docker compose exec api node dist/cli.js keys create mysite
```

Prebuilt images (`linux/amd64`, `linux/arm64`): `ghcr.io/thesupersupersigma/reconsumet-api` and
`ghcr.io/thesupersupersigma/reconsumet-relay` (`docker compose pull`). HTTPS, reverse proxies, Cloudflare, bandwidth,
upgrades and backups: **[docs/self-hosting.md](docs/self-hosting.md)**. An optional Coolify example:
[docs/deploy/coolify.md](docs/deploy/coolify.md).

## Development

Node 26 and pnpm. `pnpm install`, then `pnpm build` (the packages import each other's built `dist/`, so build before
testing), `pnpm test` (offline; Postgres tests run on PGlite, no Docker needed), `pnpm test:live` (real sites, AniList,
tls.peet.ws, and API → relay end to end), `pnpm lint`, `pnpm typecheck`. API + relay without Docker: put
`DATABASE_URL` and `RELAY_SECRET` in `.env`, then `pnpm dev` ([docs/self-hosting.md](docs/self-hosting.md)).

The dev CLI keeps its data in `./data` (or `RECONSUMET_DATA_DIR`):

```sh
pnpm reconsumet catalog update     # import the anime offline database (weekly)
pnpm reconsumet anilist sync       # this season's shows from AniList (daily)
pnpm reconsumet streams 154587 1   # AniList ID + episode → streams + subtitles
pnpm reconsumet --help
```

## Versioning

- `0.N.0` = the state after milestone N; `0.N.x` = small fixes in between.
- `1.0.0` = everything v1 could do, rebuilt properly.
- A release is a git tag `vX.Y.Z` matching the version in `package.json`.

## Community

Questions, bugs and ideas: the [Discord](https://discord.gg/trvtVNWzaf), or GitHub issues.

## Data attribution

The anime catalog is derived from
[manami-project/anime-offline-database](https://github.com/manami-project/anime-offline-database), licensed under the
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) with contents under the
[DbCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/) (details in [docs/catalog.md](docs/catalog.md)). Show
metadata also comes from [AniList](https://anilist.co).

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Untouched consumet.ts v1.8.1 source is used as a reference (in the
gitignored `_reference/` folder); consumet.ts is GPL-3.0.
