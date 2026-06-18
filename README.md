<!-- TODO: rename the project before publishing (rebranding away from "consumet"). -->
# Anime Aggregator (working title)

A **self-hostable** anime aggregator: a TypeScript scraping library plus a small
HTTP API with a built-in HLS/subtitle proxy. Designed to run on your own machine —
**there is no public hosted instance.**

> Status: work in progress / personal project.

## What it is

- A trimmed, revived fork of [`@consumet/extensions`](https://github.com/consumet/extensions)
  focused on a few **reliable, mostly browser-free** anime sources, an AniList-based
  aggregator, and **English subtitles**.
- Two parts:
  - **`consumet/`** — the scraping library (providers + extractors). Builds to
    CommonJS in `consumet/dist`.
  - **`api/`** — a [Fastify](https://fastify.dev) service that imports the library and
    exposes search / info / episodes / watch, plus a Referer-injecting HLS + subtitle
    proxy so streams play in a normal browser.

## Sources

| Provider | Browser-free | English subtitles | Notes |
|---|---|---|---|
| **AniNeko** | ✅ | ✅ soft, incl. simulcasts | default; subs ride in the embed URL |
| **AnimeNoSub** | ✅ | ✅ soft (back-catalog via megaplay) | simulcast video via Nova/Vidmoly (hardsub) |
| **Gogoanime** | needs a headless browser (CDP) | ✅ soft via megaplay | fallback only |
| **AnimeUnity** | ✅ | ❌ (Italian) | fallback video |

A headless browser (Chrome DevTools Protocol, e.g. a stealth Chromium) is **optional** —
only the Gogoanime fallback uses it. Point the library at it with `CLOAK_CDP_URL`.

See **[`SOURCES.md`](./SOURCES.md)** for the full per-source status and the tracker of
candidate sites.

## Quick start

```bash
# 1) build the library
cd consumet
pnpm install
npx tsc -p tsconfig.json        # emits CommonJS to consumet/dist

# 2) run the API
cd ../api
pnpm install
pnpm start                      # listens on $PORT (default 3000)
```

Endpoints:

```
GET /search?q=<query>
GET /info/:anilistId
GET /episodes/:anilistId?provider=AniNeko
GET /watch?provider=AniNeko&episodeId=<id>&type=sub   # returns proxied m3u8 + subtitle urls
GET /proxy?url=<m3u8|vtt>&ref=<referer>                # Referer-injecting stream proxy
```

Env: `PORT`, `CLOAK_CDP_URL` (only for the Gogoanime fallback).

## How it works

- Search and metadata come from the **AniList GraphQL API** (no scraping). A title is
  matched across the configured providers, then episodes/sources are resolved per provider.
- Sources are **HLS (`.m3u8`)**. Many CDNs are Referer-locked, so the API **proxies**
  streams (`/proxy`) — it injects the right `Referer`, rewrites playlist URLs, and adds CORS
  so playback works in any browser.

## Self-host & legal

- **No hosted instance is provided.** Run it yourself, for personal use.
- This project **does not host, store, or distribute** any media. It indexes and links to
  streams that are publicly available on third-party sites, and is **not affiliated** with
  any of them.
- It's intended for **personal and educational** use. You are responsible for complying with
  the laws and terms applicable in your jurisdiction.

## Credits

Built on [`@consumet/extensions`](https://github.com/consumet/extensions). See
`consumet/LICENSE` for the upstream license; keep the original copyright for borrowed code.
