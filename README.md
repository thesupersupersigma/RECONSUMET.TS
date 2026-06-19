<p align="center">
  <img src="RECONSUM%CE%A3T-TS.png" alt="RECONSUMΣT.TS" width="640">
</p>

<h1 align="center">RECONSUMΣT.TS</h1>

<p align="center">
  A <b>self-hostable</b> anime aggregator — a TypeScript scraping library plus a small
  HTTP API with a built-in HLS + subtitle proxy, so streams play in a normal browser.
</p>

<p align="center">
  <i>A trimmed, revived fork of <a href="https://github.com/consumet/extensions"><code>@consumet/extensions</code></a>,
  focused on a few reliable, mostly browser-free sources and real English subtitles.</i>
</p>

<p align="center">
  <b>There is no public hosted instance — you run it yourself.</b>
</p>

---

## Highlights

- **Mostly browser-free.** The primary sources scrape over plain HTTP — no headless
  browser needed for the common path.
- **Real English subtitles**, including *soft* subs for simulcasts (toggleable `.vtt`)
  and fansub-grade `.ass` tracks.
- **AniList-based aggregation.** Search/metadata come from the AniList GraphQL API (no
  scraping); a title is matched across providers, so one AniList id resolves to many sources.
- **Browser-ready streams.** A `/proxy` injects the right `Referer`, rewrites HLS
  playlists, adds CORS, and (where needed) does TLS-impersonation + playlist
  de-obfuscation so HLS just plays in `hls.js`/`<video>`.

## Sources

| Provider | Browser-free | English subtitles | Notes |
|---|---|---|---|
| **AniNeko** | ✅ | ✅ soft, incl. simulcasts | default; `.vtt` rides in the embed URL |
| **AnimeNoSub** | ✅ | ✅ soft (back-catalog via megaplay) | simulcast video via Nova/Vidmoly |
| **AnikotoTV** | ✅ | ✅ soft (HD-1 via megaplay) | nekostream backend; reuses megaplay + vibeplayer |
| **ReAnime** | ✅ | ✅ high-quality `.ass` | flixcloud video needs the TLS-impersonating proxy (see below) |
| **Gogoanime** | needs a headless browser (CDP) | ✅ soft via megaplay | fallback only |
| **AnimeUnity** | ✅ | ❌ (Italian) | fallback video |

A headless browser (Chrome DevTools Protocol, e.g. a stealth Chromium) is **optional** —
only the Gogoanime fallback uses it (`CLOAK_CDP_URL`). See **[`SOURCES.md`](./SOURCES.md)**
for full per-source status and the candidate-site tracker.

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
pnpm start                        # listens on $PORT (default 3000)

# health check
curl http://localhost:3000/
```

For a full VM deployment (Cloudflare Tunnel, cloakbrowser, curl-impersonate), see
**[`SETUP.md`](./SETUP.md)**.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | API listen port |
| `PUBLIC_URL` | derived from request | Base URL used when building `/proxy` links |
| `CLOAK_CDP_URL` | `http://localhost:9222` | cloakbrowser CDP endpoint — only the Gogoanime fallback needs it |
| `CURL_IMPERSONATE_BIN` | *(unset)* | Path to a [curl-impersonate](https://github.com/lexiforest/curl-impersonate) binary; enables fetching CF/JA3-gated CDNs |
| `CURL_IMPERSONATE_ARGS` | *(empty)* | Extra args, e.g. `--impersonate chrome124` (single-binary builds) |
| `TLS_IMPERSONATE_HOSTS` | `flixcloud.cc,overcdn.site` | Comma-list of host suffixes routed through curl-impersonate |

---

## API reference

All responses are JSON unless noted. Examples use Re:Zero (AniList id `21355`).

### `GET /`
Health + capabilities.

```jsonc
{
  "name": "anime-api",
  "status": "ok",
  "cloakbrowser": "UNREACHABLE — Gogoanime episodes need it",
  "tlsImpersonation": { "enabled": true, "hosts": ["flixcloud.cc", "overcdn.site"] },
  "providers": ["AniNeko", "AnimeNoSub", "AnikotoTV", "ReAnime", "Gogoanime", "AnimeUnity"],
  "routes": { /* ... */ }
}
```

### `GET /search?q=<query>&page=1`
Search via AniList. Returns up to 15 matches per page.

```jsonc
// GET /search?q=re:zero
{
  "results": [
    {
      "id": "21355",                 // AniList id — use this everywhere below
      "malId": 31240,
      "title": {
        "romaji": "Re:Zero kara Hajimeru Isekai Seikatsu",
        "english": "Re:ZERO -Starting Life in Another World-",
        "native": "Re:ゼロから始める異世界生活"
      },
      "image": "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21355-...jpg",
      "totalEpisodes": 25,
      "type": "TV",
      "status": "FINISHED"
    }
  ]
}
```

### `GET /info/:anilistId`
Which providers have this title (the `mappings` array = your **available sources**),
sorted by title-match score.

```jsonc
// GET /info/21355
{
  "id": "21355",
  "mappings": [
    { "provider": "AniNeko",   "id": "rezero-starting-life-in-another-world",          "title": "Re:ZERO ...", "score": 1 },
    { "provider": "AnikotoTV", "id": "re-zero-starting-life-in-another-world-scuep",    "title": "Re:ZERO ...", "score": 1 },
    { "provider": "AnimeNoSub", "id": "rezero-starting-life-in-another-world-season-4", "title": "Re:ZERO ...", "score": 0.9 }
  ]
}
```

### `GET /episodes/:anilistId?provider=<name>`
Episode list. `provider` is optional — without it, the aggregator falls through the
configured order until one yields episodes.

```jsonc
// GET /episodes/21355?provider=AniNeko
{
  "provider": "AniNeko",
  "providerId": "rezero-starting-life-in-another-world",
  "episodes": [
    {
      "id": "rezero-starting-life-in-another-world/ep-1",  // pass this to /watch
      "number": 1,
      "title": "Episode 1",
      "url": "https://anineko.to/watch/rezero-starting-life-in-another-world/ep-1"
    }
    // ...
  ]
}
```

### `GET /watch?provider=<name>&episodeId=<id>&type=sub`
Resolve a playable source. `type` is `sub` (default) or `dub`. **`episodeId` must be
URL-encoded** (ids often contain `/`).

`url` fields are pre-wrapped through `/proxy` and are ready for `hls.js`/`<video>`;
`rawUrl` is the original upstream URL.

```jsonc
// GET /watch?provider=AniNeko&episodeId=rezero-...%2Fep-1&type=sub
{
  "sources": [
    {
      "url": "http://localhost:3000/proxy?url=https%3A%2F%2F...%2Fmaster.m3u8&ref=...",
      "rawUrl": "https://vibeplayer.site/public/stream/<id>/master.m3u8",
      "quality": "auto",
      "isM3U8": true
    }
  ],
  "subtitles": [
    { "url": "http://localhost:3000/proxy?url=...eng.vtt", "rawUrl": "https://.../eng.vtt", "lang": "English" }
  ],
  "intro": { "start": 0, "end": 0 },
  "outro": { "start": 0, "end": 0 },
  "headers": { "Referer": "https://vibeplayer.site/" }
}
```

> Point an HLS player at `sources[0].url` and add `subtitles[].url` as text tracks — no
> extra headers needed; the proxy handles `Referer`, CORS, and any decryption.

### `GET /proxy?url=<encoded>&ref=<encoded>&pk=<encoded>`
The streaming proxy (you normally don't call this directly — `/watch` builds the links).
It fetches `url` with the right `Referer`, rewrites HLS playlists so every segment/key/
sub-playlist also routes back through the proxy, and adds CORS. For CF/JA3-gated CDNs it
uses curl-impersonate; for sources that obfuscate the playlist body it de-obfuscates with
the per-video key `pk`.

---

## How it works

- **Search & metadata:** AniList GraphQL (no scraping). Titles (incl. synonyms) are matched
  across providers by string similarity, so one AniList id maps to many sources.
- **Sources are HLS (`.m3u8`).** Many CDNs are `Referer`-locked, some are Cloudflare/JA3
  fingerprint-gated, and some obfuscate the playlist body. The `/proxy` handles all three:
  Referer injection + playlist rewriting (always), TLS-impersonation (for hosts in
  `TLS_IMPERSONATE_HOSTS`, via `CURL_IMPERSONATE_BIN`), and playlist de-obfuscation (when a
  source supplies a key). The decryption/crack logic for individual hosts lives in the
  library's extractors (`consumet/src/extractors/`).

## Contributing

New sources, fixes, and docs are welcome — see **[`CONTRIBUTING.md`](./CONTRIBUTING.md)**.
The guiding principle is **browser-free first**, with real soft subtitles where possible.

## Self-host & legal

- **No hosted instance is provided.** Run it yourself, for personal use.
- This project **does not host, store, or distribute** any media. It indexes and links to
  streams publicly available on third-party sites, and is **not affiliated** with any of them.
- Intended for **personal and educational** use. You are responsible for complying with the
  laws and terms applicable in your jurisdiction.

## License

[GPL-3.0](./LICENSE) — inherited from `@consumet/extensions` (copyleft: public forks/derivatives
must also be GPL-3.0 and keep the upstream copyright). See [`consumet/LICENSE`](./consumet/LICENSE).

## Credits

Built on [`@consumet/extensions`](https://github.com/consumet/extensions).
