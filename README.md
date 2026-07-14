<p align="center">
  <img src="RECONSUM%CE%A3T-TS.png" alt="RECONSUMΣT.TS" width="640">
</p>

<p align="center">
  A <b>self-hostable</b> anime aggregator — a TypeScript scraping library plus a small
  HTTP API with a built-in HLS + subtitle proxy, so streams play in a normal browser.
</p>

<p align="center">
  <i>A trimmed, revived fork of <a href="https://github.com/consumet/extensions"><code>@consumet/extensions</code></a>,
  focused on reliable sources, real English subtitles, and honest documentation of what
  each source actually requires.</i>
</p>

<p align="center">
  <b>Live at <a href="https://api.thesupersuperanime.lol">api.thesupersuperanime.lol</a></b> —
  public documentation at <a href="https://docs.thesupersuperanime.lol">docs.thesupersuperanime.lol</a>.
</p>

---

## Highlights

- **13 aggregated sources**, from plain-HTTP scrapes to genuinely multi-server/multi-audio
  self-hosted APIs to two Cloudflare-Managed-Challenge-gated sites cleared via a headless
  browser solver. See [Sources](#sources) below for the honest breakdown of each.
- **Real English subtitles** across most sources, including *soft* subs for simulcasts
  (toggleable `.vtt`) and fansub-grade `.ass` tracks.
- **AniList-based aggregation.** Search/metadata come from the AniList GraphQL API (no
  scraping); a title is matched across providers, so one AniList id resolves to many sources.
- **Multi-server responses.** `/watch` returns *every* server a source offers for both sub
  and dub — not just one — ordered with the default/auto-play server first.
- **Browser-ready streams.** A `/proxy` injects the right `Referer`/`Origin`, rewrites HLS
  playlists, adds CORS, and (where needed) does TLS-impersonation, playlist de-obfuscation,
  or a source-specific key transform, so HLS just plays in `hls.js`/`<video>`.

## Sources

| Provider | Access | Notes |
|---|---|---|
| **AniNeko** | plain HTTP | Browser-free. Soft English subs, including simulcasts. |
| **AnimeNoSub** | plain HTTP | Browser-free. Back-catalog via MegaPlay (7-language soft subs); simulcasts via Nova → Vidmoly fallback. |
| **AnikotoTV** | plain HTTP | Browser-free (nekostream backend). HD-1 → MegaPlay (soft English subs). |
| **ReAnime** | TLS-impersonate | Browser-free REST API, high-quality `.ass` English subs. Video (FlixCloud) is TLS/JA3-fingerprint-gated → plays through the proxy. |
| **Gogoanime** | plain HTTP | Browser-free (no headless browser needed — its AJAX nonce/params are readable straight off the raw page HTML). Legacy fallback catalog. |
| **AnimeUnity** | fallback only | Italian site, no native English subtitles (an external subtitle layer supplies English captions). Kept as a fallback video source, not a primary. |
| **AniZone** | TLS-impersonate | Browser-free, server-rendered — the HLS master sits directly in the page HTML. Rich soft subs incl. English `.ass`. CDN is fingerprint-gated → plays via proxy. |
| **AniDB** | TLS-impersonate | Self-hosted, genuinely multi-server (one server per audio language). Metadata host is fingerprint-gated → impersonated; its video CDN is open. |
| **UniqueStream** | self-hosted API | Crunchyroll re-host with a clean, self-documented API. Genuinely multi-server: one server per audio locale (JP sub + every dub language CR carries). Signed, short-TTL HLS; its `key.bin` is itself encrypted and needs a bespoke SHA-256-derived AES-128 key before use (see `utils/cf-solver.ts` sibling logic in `server.mjs`). |
| **KickAssAnime** | self-hosted API | Clean JSON API. One HLS master carries both Japanese (sub) and English (dub) audio groups; segment CDN requires a specific `Origin` header. |
| **Senshi** | self-hosted API | Clean REST API, no anti-bot at all. Multi-server per audio type. Subtitles are burned-in hardsubs, not a separate track. |
| **AnimePahe** | Cloudflare + solver | Large catalog behind Cloudflare's Managed Challenge (Turnstile/JS-VM tier — hard-blocks plain HTTP *and* TLS-impersonation alone). Cleared via [Byparr](https://github.com/ThePhaseless/Byparr), a FlareSolverr-compatible headless-browser solver, on a solve-once/cache-and-reuse model. Multi-server per episode (sub/dub × 360/720/1080p). |
| **Mkissa** | Cloudflare + solver | An AllAnime/AllManga front-end (`mkissa.to`) behind the identical Cloudflare challenge as AnimePahe — shares the same solver infrastructure. |

Every provider's real access requirements are documented above, not assumed — several
(Gogoanime, AnimePahe, Mkissa) were previously mischaracterized in this repo's own history
before being re-verified against the live sites. See **[`SOURCES.md`](./SOURCES.md)** for
the full per-source build history and the candidate-site tracker.

### A note on "browser-free"

Two sources (AnimePahe, Mkissa) genuinely require Byparr, a real headless-browser service,
to clear Cloudflare's Managed Challenge — this is a real, current dependency, not a legacy
one. `cloakbrowser` (an older, different browser dependency this project used to have for
Gogoanime) was fully removed after Gogoanime turned out not to need a browser at all — its
own AJAX parameters are readable straight from plain HTML. Don't conflate the two: Byparr
is a live, load-bearing dependency for two sources; cloakbrowser is gone and unrelated.

## Layout

```
consumet/   the scraping library (providers + extractors). Builds to CommonJS in consumet/dist
api/        a Fastify service that imports the library and exposes the HTTP API + stream proxy
```

## Quick start

```bash
# 1) build the library
cd consumet
pnpm install
npx tsc -p tsconfig.json          # emits CommonJS to consumet/dist
                                  # (~12 pre-existing strict-type warnings are expected)
# 2) run the API
cd ../api
pnpm install
pnpm start                        # listens on $PORT (default 3000; production runs on 4000)

# health check
curl http://localhost:3000/
```

For a full VM deployment (Coolify, curl-impersonate, Byparr), see
**[`SETUP.md`](./SETUP.md)**.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | API listen port |
| `PUBLIC_URL` | derived from request | Base URL used when building `/proxy` links |
| `CURL_IMPERSONATE_BIN` | *(unset)* | Path to a [curl-impersonate](https://github.com/lexiforest/curl-impersonate) binary; enables fetching CF/JA3-gated CDNs. When empty, TLS impersonation silently no-ops (plain fetch → those hosts 403) — a working binary path in production is required, not just this env var. |
| `CURL_IMPERSONATE_ARGS` | *(empty)* | Extra args, e.g. `--impersonate chrome124` (single-binary builds) |
| `TLS_IMPERSONATE_HOSTS` | `flixcloud.cc,overcdn.site,vid-cdn.xyz,xin-cdn.xyz,anidb.app,uwucdn.top` | Comma-list of host suffixes routed through curl-impersonate |
| `BYPARR_URL` | `http://flaresolverr:8191` | Base URL of the Byparr (FlareSolverr-compatible) solver instance, used by AnimePahe and Mkissa to clear Cloudflare's Managed Challenge. Container is kept under the name `flaresolverr` for drop-in compatibility with FlareSolverr's own API shape. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_SCRAPE` / `RATE_LIMIT_WATCH` / `RATE_LIMIT_PROXY` | `120`/`60`/`30`/`600` per minute | Tiered per-IP rate limits (see `server.mjs` header comment for the full table) |
| `API_KEY` | *(unset)* | If set, gates `/search /info /episodes /watch` behind `x-api-key`/`Bearer`. Off by default. |
| `DEBUG_INFO` | *(unset)* | If `1`/`true`, `GET /` also exposes TLS-impersonation diagnostics. Off by default. |

---

## API reference

All responses are JSON unless noted. Full endpoint reference with real, live-captured
examples: **[docs.thesupersuperanime.lol](https://docs.thesupersuperanime.lol)**. Short
summary below — examples use Frieren (AniList id `154587`).

### `GET /`
Health + capabilities. Returns `status`, the **live provider list** (in aggregation
order), and a route summary.

### `GET /search?q=<query>&page=1`
Search via AniList. Returns AniList metadata, including the `id` used everywhere below.

### `GET /info/:anilistId`
Which providers have this title (`mappings[]` = available sources), each with a
title-match `score`.

### `GET /episodes/:anilistId?provider=<name>`
Episode list for a title. `provider` is an optional preference; the aggregator verifies
season/episode-count correctness before returning (see `TODO.md` history) rather than
silently serving a wrong season.

### `GET /watch?provider=<name>&episodeId=<id>`
Resolve playable sources. Returns `{ sub: [...] | null, dub: [...] | null }` — **each an
array of every server that provider offers** for that audio type, ordered with the
default/auto-play server first. `sources[].url` / `subtitles[].url` are pre-wrapped
through `/proxy` and ready for `hls.js`/`<video>`; `rawUrl` is the original upstream URL.

**`episodeId` is provider-specific, not a universal identifier — always get it from
`/episodes`, don't guess it.** Each source addresses its own episodes with its own
internal scheme: AniNeko uses `<slug>/ep-<n>`, ReAnime uses `<anilistId>/<episodeNumber>`,
AnikotoTV uses a raw numeric ID from its own backend, and so on — there's no shared
format across providers, because each one's video is ultimately addressed by *that
site's* own system, not by AniList's episode numbering. `/search` and `/info` DO
normalize around a single universal identifier (the AniList id) because that's a
show-level concept every provider can be matched against by title — but at the episode
level, that universality breaks down, since AniList doesn't know or care how any given
provider numbers its own episodes internally.

This is a deliberate tradeoff, not an oversight: `/watch` could look up the right
episodeId itself given just an AniList id + episode number (calling `/episodes`
internally on every request), but that would mean paying the cost of a fresh
episode-list fetch on every single `/watch` call — even for a caller who already knows
exactly which episode they want and has already done that lookup once. The current
design optimizes for "do the discovery once via `/episodes`, then make fast, direct
`/watch` calls after that" over "every call is maximally convenient but repeats work."
A smart client (like this project's own front-end) does the `/info` → `/episodes` →
`/watch` chain once per title and reuses the result, rather than re-resolving on every
request.

### `GET /proxy?url=<encoded>&ref=<encoded>&...`
The streaming proxy (you normally don't call this directly — `/watch` builds the links).
Injects `Referer`/`Origin`, rewrites HLS playlists so children also route through the
proxy, adds CORS, and — depending on the source — does TLS-impersonation, playlist
XOR de-obfuscation, a custom key derivation (UniqueStream), or an audio-track default
rewrite (KickAssAnime).

---

## How it works

- **Search & metadata:** AniList GraphQL (no scraping). Titles (incl. synonyms) are matched
  across providers by string similarity plus season/episode-count verification, so one
  AniList id maps to the *correct* season on each source, not just a title-similar one.
- **Sources are mostly HLS (`.m3u8`).** Every source has its own real access pattern —
  plain HTTP, `Referer`/`Origin`-locked, TLS/JA3 fingerprint-gated, playlist-obfuscated,
  or (AnimePahe/Mkissa) behind a full Cloudflare Managed Challenge needing a real headless
  browser. The `/proxy` and the Byparr-based solver (`utils/cf-solver.ts`) handle all of
  these; the specific decode/crack logic for individual hosts lives in the library's
  extractors (`consumet/src/extractors/`).

## Contributing

New sources, fixes, and docs are welcome — see **[`CONTRIBUTING.md`](./CONTRIBUTING.md)**.
Document a source's *real* access requirements from live verification, not assumption —
this repo has been burned before by carrying forward stale "needs a browser"/"is
CF-gated" claims across sessions without re-checking them against the live site.

## Self-host & legal

- This is a personal project. A live instance exists at `api.thesupersuperanime.lol` for
  the maintainer's own front-end, with public documentation, but with no uptime or
  stability guarantee — see the docs site's disclaimer.
- This project **does not host, store, or distribute** any media. It indexes and links to
  streams publicly available on third-party sites, and is **not affiliated** with any of them.
- Intended for **personal and educational** use. You are responsible for complying with the
  laws and terms applicable in your jurisdiction.

## License

[GPL-3.0](./LICENSE) — inherited from `@consumet/extensions` (copyleft: public forks/derivatives
must also be GPL-3.0 and keep the upstream copyright). See [`consumet/LICENSE`](./consumet/LICENSE).

## Credits

Built on [`@consumet/extensions`](https://github.com/consumet/extensions). Cloudflare
Managed Challenge bypass via [Byparr](https://github.com/ThePhaseless/Byparr).
