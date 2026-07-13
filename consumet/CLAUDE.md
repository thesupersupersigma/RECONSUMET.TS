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

THE TLS-FINGERPRINT GATE — SOLVED (curl-impersonate):
- Some CDNs gate on the **TLS/HTTP2 fingerprint (JA3/JA4)**: reanime/flixcloud's `fetch5.flixcloud.cc`
  + segment host `*.overcdn.site`, and historically the megaplay CDN family. Real browser → 200; plain
  Node/axios → `403` "Attention Required", regardless of Referer/headers. No `cf_clearance` cookie is
  involved — it's purely the handshake (+ the request must be *fetch*-style: `Sec-Fetch-*: cors/empty`,
  `Origin`, `Accept: */*` — navigation-style headers still 403).
- FIX (shipped): the `api/` `/proxy` routes hosts in `TLS_IMPERSONATE_HOSTS` (default
  `flixcloud.cc,overcdn.site`) through **curl-impersonate** (`CURL_IMPERSONATE_BIN`, optional
  `CURL_IMPERSONATE_ARGS="--impersonate chrome124"`) via a per-request child process: response headers to
  fd 3, body streamed from stdout, range-aware, child killed on client disconnect. Plain `fetch` for
  everything else. We dropped **ViperTLS** (sketchy author + it hung); curl-impersonate is lighter (no
  chromium) and proven. Verified e2e with curl_cffi shim: 200 on the gated CDN + valid MPEG-TS segments.
- (lwthiker/lexiforest **curl-impersonate** — patched curl w/ BoringSSL; static linux x86_64/aarch64 binaries.)

RAM: user is on an **8GB Mac** → tight, but curl-impersonate adds ~nothing (no browser). cloakbrowser
(Docker Chromium ~4GB) is only for the Gogoanime fallback; `docker stop cloak` when idle.

Still deferred: external captions (Jimaku/OpenSubtitles need keys — see Captions section); harden Gogoanime
across titles/dub; 3rd source. AnimePahe blocked (JWE/ad gate). Then: redis cache, docker-compose, deploy.

## Session 4–5 update — two new browser-free sources; cloakbrowser now OPTIONAL
Provider set is now **AniNeko → AnimeNoSub → Gogoanime → AnimeUnity** (aggregator default order).
Full per-site details live in repo-root **`SOURCES.md`** (the site tracker) and in the Claude memory
files `animenosub-source.md` + `anineko-source.md`. Highlights:

- **AnimeNoSub** (`src/providers/anime/animenosub.ts`) — fully browser-free (search + episodes +
  servers all plain HTTP; servers are base64 `<iframe>` in a `<select class="mirror">`). Back-catalog =
  **megaplay** (soft English subs, +6 langs). Simulcast video = **Nova** (`src/extractors/nova.ts`,
  AES-128-CBC cracked: key `kiemtienmua911ca`, iv `1234567890oiuytr`) or **Vidmoly** (`vidmoly.ts`,
  fixed single-quote regex). Moon=Filemoon/Byse skipped (session GraphQL).
- **AniNeko** (`src/providers/anime/anineko.ts`) — fully browser-free AND the FIRST source with
  **extractable soft English subtitles for SIMULCASTS** (the long-standing gap). The player is at
  `/watch/<slug>/ep-N` (NOT `?ep=N` = info page); it server-renders `[data-video]` servers; the
  Soft-Sub ones attach a separate English `.vtt` in the query string (`?sub=`/`caption_1=`/`c1_file=`
  on cdn.anizara.store). Video = **VibePlayer** (`src/extractors/vibeplayer.ts`, HD-1, m3u8 at
  `vibeplayer.site/public/stream/<id>/master.m3u8`).

- **cloakbrowser is now OPTIONAL** — only the Gogoanime fallback needs it. AniNeko + AnimeNoSub are
  pure HTTP, so the common path runs without a browser. User runs cloakbrowser on their Oracle VM
  (CDP) only when needed; default `CLOAK_CDP_URL`.
- **CDN TLS-gate appears LIFTED** for these hosts: megaplay (streamzone1.site), vidmoly (vmeas.cloud),
  vibeplayer, nova (cf-master) all fetch 200 server-side via plain axios + Referer — master + segments +
  vtt. So **ViperTLS may be unnecessary** for the AniNeko/AnimeNoSub paths (keep as a fallback; re-test
  from the Oracle VM IP before ripping it out — see animenosub-source.md caveats).
- API (`api/`) unchanged: `/search /info /episodes /watch /proxy`. `/watch` should now also surface
  `subtitles[]` for AniNeko/megaplay (the proxy injects Referer for m3u8/vtt).

## Session 6 update — cloakbrowser was NEVER actually needed; fully removed
The "Gogoanime needs a JS anti-bot browser" claim throughout this doc (Sessions 1–5) was **never
verified against the live site** and turned out to be false. Investigated properly this session:
`gogoanimez.to`'s anime-info page returns `HTTP 200` over plain `curl` with the episode list
empty in raw HTML (`<ul id="episode_related"><li class="loading">...`), but the WordPress AJAX
params it needs — `data-range-start`/`data-range-end`/`data-seri` on `#episode_page > li a`, and
the `nonce` in an inline `<script>` — are **already sitting in that same raw HTML**. `POST
/wp-admin/admin-ajax.php?action=load_episode_range` with those params, **no headers/cookies/UA
required at all**, returns the full episode list as JSON. No Cloudflare Managed Challenge, no
Turnstile, no TLS/JA3 gate ever showed up — Cloudflare here is a passive CDN only.

- `gogoanime.ts`'s `fetchAnimeInfo` was rewritten to do exactly that over plain HTTP
  (`this.client`), replacing the cloakbrowser render. Verified end-to-end live: a back-catalog
  title (`naruto-2002`, 218 episodes, contiguous) and a currently-airing simulcast (`Azur Lane:
  Slow Ahead! Season 2`, 2 episodes) both resolve correctly through info → episodes → sources.
  (Naruto has two real gaps, ep 10 and ep 200 — confirmed the site itself 301s those URLs to the
  homepage; not a scraping bug, the old browser path would hit the same gap.)
- **cloakbrowser is now removed entirely, not just optional.** Deleted `src/utils/browser-fetcher.ts`
  (zero remaining importers repo-wide, confirmed by grep across `consumet/src/**` and `api/**`),
  dropped `puppeteer-core` from `package.json`/lockfile, removed the `Gogoanime` constructor's
  `cdpUrl` param, removed the `cloakReachable()`/`CLOAK_CDP_URL` health-check code from
  `api/src/server.mjs` (the `/` route's `cloakbrowser` field is gone), and cleared `BROWSER_BACKED`
  in `aggregator.ts` (kept as an empty hook for any future genuinely-expensive provider). Updated
  README/SETUP/CONTRIBUTING/TODO/SOURCES accordingly. The `cloakhq/cloakbrowser` Docker container
  the user was running on the VM has no remaining caller anywhere in this repo and can be stopped.
- **Lesson:** don't carry forward an unverified "needs a browser" assumption across sessions —
  re-check it against the live site with plain `curl` before building (or keeping) infrastructure
  around it.
