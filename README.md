<p align="center">
  <img src="RECONSUM%CE%A3T-TS.png" alt="RECONSUMΣT.TS" width="640">
</p>

<p align="center">
  <a href="https://discord.gg/trvtVNWzaf"><img src="https://img.shields.io/badge/discord-join-5865F2" alt="Discord"></a>
  <img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="License: GPL-3.0-or-later">
  <img src="https://img.shields.io/badge/version-0.1.0-orange" alt="Version 0.1.0">
</p>

# RECONSUMΣT.TS — v2 (rewrite in progress)

A self-hostable anime aggregator: a TypeScript scraping library plus an HTTP API with a built-in HLS + subtitle proxy.
It turns an AniList ID and an episode number into playable streams from whichever sources currently work.

**v2 is being rewritten from scratch.** Nothing on this branch runs yet.
The previous version (v1, June–August 2026) is kept on the [`old`](../../tree/old) branch.

## Versioning

- `0.N.0` = the state after milestone N; `0.N.x` = small fixes in between.
- `1.0.0` = everything v1 could do, rebuilt properly.
- A release is a git tag `vX.Y.Z` matching the version in `package.json`.

## Community

Questions, bugs and ideas: the [Discord](https://discord.gg/trvtVNWzaf), or GitHub issues.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Untouched consumet.ts v1.8.1 source is used as a reference (in the
gitignored `_reference/` folder); consumet.ts is GPL-3.0.
