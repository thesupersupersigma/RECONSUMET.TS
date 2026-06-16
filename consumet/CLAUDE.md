# CLAUDE.md — consumet revival (working notes for Claude)

> This is a **revived fork of `@consumet/extensions` v1.7.0** (the only folder kept from the
> original three). Goal: a **self-host-first** anime scraper/aggregator with multiple sources,
> reliable captions, eventually public. Owner is iterating with Claude across sessions.
> There is **NO git repo here** — do **not** run `git init` (owner's explicit instruction).
> Persistent cross-session notes also live in the Claude memory file `consumet-revival.md`.

## Current scope decision
Keep only **3 anime providers**, drop everything else:
- **Gogoanime** — biggest EN catalog (needs rework, see below)
- **AnimePahe** — good quality + EN subs (needs rework, see below)
- **AnimeUnity** (Italian) — the only provider that worked out-of-box; kept as optional fallback
  (its Italian-only subs don't matter because captions come from an external layer; the video stream is what counts).

Dead/removed providers: Zoro/hianime, 9anime/aniwave, AnimeFox, AnimeDrive, Anify, Marin,
AnimeSaturn, Crunchyroll, Bilibili, kickassanime. Their files were deleted.

## What's already done (in this codebase)
1. **Pruned providers** — `src/providers/anime/index.ts` and `src/utils/providers-list.ts`
   now expose only Gogoanime, AnimePahe, AnimeUnity.
2. **Refactored the meta layer** — `src/providers/meta/anilist.ts` + `mal.ts` no longer depend
   on the deleted providers (removed `Anify` fallbacks — Anify's API is dead/404 — and
   always-false `instanceof` branches). `META.Anilist`/`Myanimelist` still load with Gogoanime
   as the default provider. This is the AniList/MAL mapping backbone for future aggregation.
3. **Built the MegaPlay extractor** — `src/extractors/megaplay.ts` (registered in
   `src/extractors/index.ts` and exported from `src/index.ts` as `MegaPlay`). **Tested live, works.**
   See below — this is the reusable gem.
4. `smoke-test.mjs` (repo root) — health harness: runs search→info→sources across all ANIME
   providers and prints a PASS/FAIL matrix. Keep it; it's the CI/cron check.

## KEY TECHNICAL FINDINGS (hard-won — don't re-derive)

### The classic Gogoanime architecture is DEAD
`anitaku.pe` is parked; `ajax.gogocdn.net` returns a fingerprint-redirect placeholder, not data.
The original provider (gogocdn + `ajax.gogocdn.net/load-list-episode`) cannot be revived by
selector edits.

### The video pipeline — SOLVED (browser-free, the gem)
Surviving sites route video through **megaplay.buzz**:
```
episode → gogoanime.com.by/streaming.php?ep=<s_id>&type=sub|dub
        → <iframe> megaplay.buzz/stream/s-2/<s_id>/<type>   (read its data-id)
        → GET megaplay.buzz/stream/getSources?id=<data-id>
          ⇒ { sources:{file:<master.m3u8>}, tracks:[{English .vtt}], intro, outro }   (UNENCRYPTED JSON)
```
- Use the embed page's **`data-id`** for getSources (NOT the gogo ep id — different stream).
- m3u8 + vtt are hotlink-protected: require header **`Referer: https://megaplay.buzz/`** (403 without).
- `MegaPlay.extract(new URL('https://megaplay.buzz/stream/s-2/<sid>/<type>'))` already does all this.

### AnimeHub = `gogoanime.com.by` — browser-free catalog (but NO search)
Server-rendered, NUMERIC ids (`/anime/<id>`). Its anime page embeds the full episode list as
JSON: `episodesData = [{title, chapter_number, id:"streaming.php?ep=<s_id>&type=sub", s_id}]`.
Title = `h1`. So **info + episodes + sources are fully browser-free** given a numeric id.
BUT it has **no usable search** (`/?s=` returns the default listing; no search API/sitemap/catalog
page found — all 404). Id spaces are NOT shared with gogoanimez (e.g. `id=naruto-677` → AnimeHub
`/anime/677` = "The Fruit of Grisaia", not Naruto).

### Everything else is behind JS anti-bot → cloakbrowser is CORE, not optional
- **gogoanimez.to** (WordPress clone): search `/?s=` works browser-free (returns `/anime/<slug>/`),
  but the **episode list** loads via `wp-admin/admin-ajax.php?action=load_episode_range` behind a
  nonce that's rejected for non-browser clients (anti-scrape); theme JS serves the homepage to
  headless fetches. Cloudflare-protected.
- **AnimePahe** → live domain `animepahe.ru` (`.com`/`.org` redirect to a DDoS splash). Behind a
  **custom JS challenge** (homepage sets no cookies; `/api?m=search` returns an XHTML challenge page
  even with browser UA + cookies + XHR). The old provider relied on a now-dead `cors.consumet.stream`
  proxy. Needs JS execution.
- **Conclusion:** post-2024 every major source needs a JS-capable stealth browser. Only the
  extractors (megaplay) and AnimeHub episode pages stay browser-free.

## PLANNED ARCHITECTURE — cloakbrowser as the fetcher
- **cloakbrowser** (github.com/CloakHQ/cloakbrowser): stealth Chromium, defeats Cloudflare/DDoS-Guard/
  FingerprintJS. Run as Docker CDP server: `docker run -d --name cloak -p 127.0.0.1:9222:9222 cloakhq/cloakbrowser cloakserve`.
  CDP on :9222; connect via `puppeteer-core`/`playwright` `connectOverCDP('http://localhost:9222')`.
  No API key/license. Image is **multi-arch** (amd64 + arm64) → same command on owner's Intel Mac and
  the arm64 Oracle VM. (Native macOS binary is Apple-Silicon-only — on Intel use Docker.)
- Build a **pluggable `BrowserFetcher`** util (puppeteer-core → CDP) with two modes:
  1. **render(url)** → return final DOM/HTML after JS (for gogoanimez episode list / AnimeHub search UI).
  2. **harvestCookies(domain)** → solve the challenge once, return cookies + UA to reuse in plain axios
     (efficient for AnimePahe — solve once, then fast HTTP API calls).
- Providers use HTTP by default, `BrowserFetcher` only for the gated step. Cache results (Redis later).
- Endpoint via env (e.g. `CLOAK_CDP_URL`, default `http://localhost:9222`) so local==VM.

## Captions (DEFERRED — options for later)
MegaPlay already returns an English VTT, so **Gogoanime has English subs**. The external layer is mainly to
give **AnimeUnity** (Italian, no subs) English captions + act as a fallback. Investigated June 2026:
- **Jimaku** (jimaku.cc) — indexed by **AniList ID** (cleanest episode matching). REQUIRES a free API key
  (`401` without). Caveat: Japanese-subtitle-focused; English coverage is hit-or-miss. API:
  `GET /api/entries/search?anilist_id=<id>` (auth header) → `GET /api/entries/<id>/files`.
- **OpenSubtitles** (opensubtitles.com) — biggest English library, free API key. Caveat: no AniList mapping;
  match by title + season/episode (anime numbering is messy → fuzzy results).
- **No good keyless English-anime-subs-by-ID source exists.**
- Plan when resuming: pluggable `SubtitleService` (env keys, no-op without), supplement
  `aggregator.getSources` subtitles by AniList id + episode number. Both sources need a user-provided key.

## Build / test
- Package manager: **pnpm**. `pnpm install` already run (node_modules present, ~124MB).
- Build: `npx tsc -p tsconfig.json` → CJS output in `dist/` (`dist/index.js`).
- **Gotcha:** `tsconfig` has no `noEmitOnError`, so `tsc` EMITS despite pre-existing strictness errors
  (`rabbit.ts` Uint8Array TS2322, `anilist.ts` "always truthy" TS2872/2881). These are NOT from our
  changes and don't block the build. Only worry about `TS2307` (module-not-found) errors.
- Smoke test: `node smoke-test.mjs naruto` (hits live sites).
- Quick extractor test pattern: `import { MegaPlay } from './dist/extractors/index.js'` then
  `await new MegaPlay().extract(new URL('https://megaplay.buzz/stream/s-2/18677/sub'))`.

## Environment gotchas
- Node v25.9.0, Intel Mac (x86_64), Docker NOT yet installed.
- The per-task sandbox `/tmp` is tiny — large/multi-line Bash stdout sometimes truncates with ENOSPC.
  Keep command output small; write page dumps into the project dir (main disk), clean up after.
- Network/TLS: some sites need a real browser `User-Agent`; follow redirects (`-L`); AnimeSaturn had a
  local cert issue (it's also just down).

## Current state (working)
Pipeline: **`AnimeAggregator`** (AniList GraphQL search, no scraping) → maps a title across providers by
similarity → **Gogoanime** (cloakbrowser-rendered episode list + MegaPlay m3u8 + **English subs**) or
**AnimeUnity** (browser-free, no subs) → sources. All verified end-to-end.

Key modules added this work:
- `src/extractors/megaplay.ts` — MegaPlay extractor (m3u8 + EN subs, unencrypted).
- `src/utils/browser-fetcher.ts` — `BrowserFetcher`: connects to cloakbrowser CDP (`CLOAK_CDP_URL`, default
  `http://localhost:9222`); `withPage(fn)` auto-closes popunder ad tabs + blocks image/media/font/stylesheet;
  `closeStrayPages()`; `isAvailable()`. puppeteer-core is a dep (dynamically imported).
- `src/providers/anime/gogoanime.ts` — rebuilt for gogoanimez.to: search/sources over HTTP, `fetchAnimeInfo`
  renders via cloakbrowser then CONSTRUCTS the contiguous episode list from base-slug + range-label max +
  tail-probe (no flaky clicking).
- `src/providers/meta/aggregator.ts` — `AnimeAggregator` (exported top-level). `search`, `getMappings`,
  `getEpisodes(id, providerName?)` (preference order = provider array order, English-subs first), `getSources`.

Run cloakbrowser first (Docker, multi-arch, same on Mac + arm64 VM):
`docker run -d --name cloak -p 127.0.0.1:9222:9222 cloakhq/cloakbrowser cloakserve`.
Clear stray ad tabs if it gets slow: close each target via `curl http://localhost:9222/json/close/<id>`.

Dead ends / don't retry: legacy `META.Anilist` doesn't work with these providers (malsync/classic-gogo slugs).
**AnimePahe** is blocked (RTB ad-gate + encrypted-JWE token challenge returns HTTP 204 to cloakbrowser).

## Session 3 update — public API + the TLS-fingerprint blocker
Goal locked: host this as a public API on the user's Oracle VM (ARM, lots of RAM), behind Cloudflare,
rebranded away from "consumet" (license allows it). Git: commit after each milestone (3 commits so far on
`master`; repo root = consumet-master).

BUILT this session:
- `api/` — Fastify service (separate from the library, imports `../consumet/dist`). Routes: `/`, `/search?q=`,
  `/info/:anilistId` (mappings=sources), `/episodes/:anilistId?provider=`, `/watch?provider=&episodeId=&type=`,
  and `/proxy?url=&ref=` (Referer-injecting HLS/vtt proxy + segment streaming + CORS). `/watch` returns
  proxied + raw urls. Run: `cd api && pnpm start` (env PORT, CLOAK_CDP_URL, PUBLIC_URL).

THE BLOCKER (last mile of playback):
- megaplay's m3u8 lives on a rotating **Cloudflare CDN** (cdn.mewstream.buzz / streamzone1.site / cinewave2.site)
  that gates on **TLS fingerprint (JA3/JA4)**. Real browser (cloakbrowser) → 200; any server fetch (Node/curl)
  even with perfect Referer/headers → 403. Validated: there is **NO cf_clearance cookie** (cloakbrowser got 200
  with zero CDN cookies), so cookie-harvesting is useless — it's the TLS handshake.
- FIX = **ViperTLS** (github.com/walterwhite-69/ViperTLS, the user's recommendation) — pure-Python JA3/JA4/HTTP2
  browser impersonation, MIT, runs as a lib OR `vipertls serve` HTTP proxy. Installed in `.venv-tls/`
  (browser data in `vipertls/`, both gitignored). **VALIDATION PENDING** — `tls-test.local.py` (gitignored)
  fetches a gated m3u8 via `vipertls.Client(impersonate="chrome_*")`; first call HUNG (likely warming its
  bundled chromium under low RAM). NEXT: retry the validation with RAM free; if it returns 200 + `#EXTM3U`,
  wire the proxy to fetch CDN m3u8/segments through ViperTLS (lib call, or route through `vipertls serve` as a
  sidecar). Then playback works server-side end-to-end.

RAM: user is on an **8GB Mac** → tight. cloakbrowser (Docker Chromium) ~4GB + Node + ViperTLS's chromium.
Stop background node procs each session (I do); `docker stop cloak` when idle; cap Docker memory ~2GB.

Still deferred: external captions (Jimaku/OpenSubtitles need keys — see Captions section); harden Gogoanime
across titles/dub; 3rd source. AnimePahe blocked (JWE/ad gate). Then: redis cache, docker-compose, deploy.
