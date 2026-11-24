<p align="center">
  <img src="RECONSUM%CE%A3T-TS.png" alt="RECONSUMΣT.TS" width="640">
</p>

<p align="center">
  <a href="https://discord.gg/trvtVNWzaf"><img src="https://img.shields.io/badge/discord-join-5865F2" alt="Discord"></a>
  <img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="License: GPL-3.0-or-later">
  <img src="https://img.shields.io/badge/version-0.3.0-orange" alt="Version 0.3.0">
</p>

# RECONSUMΣT.TS — v2 (rewrite in progress)

A self-hostable anime aggregator: a TypeScript scraping library plus an HTTP API with a built-in HLS + subtitle proxy.
It turns an AniList ID and an episode number into playable streams from whichever sources currently work.

**Status: v0.3.0 — first sources.** v2 is being rewritten from scratch. `packages/core` now turns an AniList ID +
episode number into playable streams (HLS, required headers, soft subtitles) from **Re:Anime** and **AniZone**, with
season / split-cour mapping ([docs/sources.md](docs/sources.md)), on top of an anime catalog + AniList client
([docs/catalog.md](docs/catalog.md)) and the fetch layer ([docs/fetch.md](docs/fetch.md),
[docs/tls-bakeoff.md](docs/tls-bakeoff.md)). Library + CLI only; the HTTP API and the video proxy come in 0.4.
The previous version (v1, June–August 2026) is kept on the [`old`](../../tree/old) branch.

## Development

Node 26 and pnpm. `pnpm install`, then `pnpm build`, `pnpm test` (offline), `pnpm test:live` (real sites, AniList,
tls.peet.ws), `pnpm lint`, `pnpm typecheck`.

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
