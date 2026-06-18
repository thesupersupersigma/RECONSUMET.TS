# SOURCES — anime site scraping tracker

Living doc for candidate anime sites: what each uses, how far we've gotten, and
what's next. Tested anime for the new batch: **Re:Zero Season 4** (some checks
used `naruto`/`rezero` side stories). Keep this updated as sites are built.

## Status legend
- ✅ **DONE** — provider/extractor built & verified in this repo
- 🟡 **TRIAGED** — recon done, not built; backend identified or partially
- 🔵 **CANDIDATE** — known, needs recon
- ⛔ **BLOCKED** — hard anti-bot / not worth it yet

## The thing we keep optimizing for: SOFT captions
Provider-native **soft** (separate, toggleable, multi-language `.vtt`) subtitles
come almost exclusively from the **megacloud / megaplay "HD" server family** —
their `getSources` JSON returns `tracks[]` incl. English. Hardsub servers
(Filemoon, Vidmoly, Nova, Dood, StreamHG…) burn subs into the video → no
extractable track. **So when a site lists an "HD-1/HD-2" server, that's the one
to chase for soft subs — even on simulcasts.** Back-catalog on AnimeNoSub already
proves this (megaplay → 7-language soft subs).

---

## ✅ animenosub.to — DONE
Fully browser-free (search + episodes + servers all plain HTTP, no cloakbrowser).
Built: `src/providers/anime/animenosub.ts` + extractors `megaplay.ts` (had it),
`nova.ts` (new, cracked AES), `vidmoly.ts` (fixed). Commits f01ef4f / 6e3c5c5 / 9e4c576.
- Servers: **HD** (megaplay, back-catalog, **soft EN subs +6 langs**), **Nova**
  (simulcast, multi-CDN, hardsub), **Omega/Vidmoly** (simulcast, hardsub), **Moon**
  (Filemoon/Byse — session GraphQL, skipped).
- Source preference wired: MegaPlay → Nova → Vidmoly.
- See memory `animenosub-source.md` for the deep details (Nova key/iv etc.).

---

## 🔵 Candidate batch (found by user, tested on Re:Zero S4)

| Site | CF wall | Stack | Search (browser-free?) | Reported servers | Priority |
|---|---|---|---|---|---|
| anineko.to | soft (200) | hianime-style clone, `nekovault.js` | ✅ `/browser?keyword=` | Soft/Hard Sub + DUB: HD-1, HD-2, StreamHG, Earnvids, Doodstream | **HIGH** |
| anikototv.to | soft (200) | Laravel-ish (csrf), partly JS | ✅ `/search?keyword=` (also `/filter?`) | SUB/DUB: VidPlay-1, HD-1, Vidstream-2, VidCloud-1 (+ H-SUB/A-DUB = hentai: Kiwi-Stream, Download) | MED |
| reanime.to | soft (200) | JS (`window.__`) | `/search?` (form) | SUB: HD-2, DUB: HD-2 | MED |
| mkissa.to/anime | soft (200) | **Svelte SPA** | API JSON (path TBD; `/api/search` is 404-JSON so namespace exists) | Luf-Mp4, Fm-Hls, Vn-Hls, Uni, Mp4, Ok | MED |
| anidb.app | ⛔ HARD (403 "Just a moment") | unknown (gated) | needs browser | UI only exposes AUDIO eng/jpn; servers hidden | LOW |
| senshi.live | soft (200) | SPA, "New Website" (near-empty) | none in static HTML | Hard Sub: Server 1, DUB: Server 1 | LOW |

### anineko.to — HIGH value, but BLOCKED on dynamic recon (attempted, see below)
- Search `GET /browser?keyword=<q>` → server-rendered `/watch/<slug>` links (browser-free ✅).
- Anime page (`/watch/<slug>`, `?ep=N`) is the **info page**: server-rendered title +
  episode grid (`.nv-info-episode-item`, `data-content-id`/`data-episode`/`data-folder`),
  but it contains **NO player, no iframe, no `.server` elements, no external player
  domain** (only `cdn.anizara.store` for covers). data id example: content-id `8716`.
- **Player mechanism (from `js/function.js`):** servers render as
  `#player-server .server-items .server[data-video=<embedUrl>]`; click → `loadIframePlayer2(data-video)`.
  So once you HAVE the `.server` DOM, the embed URL is just `data-video`. But the code
  that POPULATES those `.server` elements is NOT in `function.js` / `nekovault.js`
  (both fully grepped — only UI: search, featured-genre, watchlist, captcha).
- **Reverse attempt (June 2026, FAILED statically):** the server-load XHR endpoint
  isn't in any static file. Endpoint-guessing is dead: ALL unknown `/ajax/*` 302→`/home`
  (catch-all), so guesses can't enumerate it. Page shows `data-logged-in="0"` — the
  player load MAY be session/login-gated. cloakbrowser was NOT running to capture it.
- **Why still worth it:** the only candidate with an explicit *Soft Sub* category +
  HD-1/HD-2 → best shot at extractable simulcast `.vtt`.
- **NEXT (clean unblock):** start cloakbrowser, render a `?ep=N` watch page, and
  **capture the network request** that fills `#player-server` (DevTools/CDP network log).
  That reveals the real endpoint + params (and whether login is needed). Then reverse
  it like Nova. Until that XHR is captured, HD-1/HD-2 = megaplay-vs-megacloud and the
  soft-sub question are UNCONFIRMED.
- **Pattern note:** these newer clones (anineko, likely anikototv/reanime too) hide the
  player behind JS+session, unlike AnimeNoSub (base64 servers in static HTML). Expect
  all of them to need cloakbrowser network-capture for the source step.

### anikototv.to — MED (also hosts hentai categories)
- Search `GET /search?keyword=<q>` → 200, `/watch/<slug>` links (browser-free ✅). `/filter?keyword=` also works.
- Servers SUB/DUB: VidPlay-1, HD-1, Vidstream-2, VidCloud-1. (H-SUB/HSUB/A-DUB are
  **hentai** sub/dub: Kiwi-Stream, Download.)
- VidCloud / Vidstream / VidPlay = the **megacloud/rapidcloud/vizcloud encrypted
  family** (hard, rotating keys) — but we have `vidcloud.ts`/`rapidcloud.ts`/`megacloud.ts`/`vizcloud.ts`. HD-1 may be megaplay/megacloud.
- **Next:** find how the source loads (page is partly JS); test if HD-1 = megaplay (easy) and carries soft subs.

### reanime.to — MED (small, simple)
- Only one server (HD-2) for both SUB and DUB → if HD-2 = megaplay/megacloud, this
  is an easy add with potential soft subs.
- **Next:** find HD-2 backend host (likely megaplay s-2 or megacloud).

### mkissa.to — MED (Svelte SPA, the "weird UI")
- Servers: Luf-Mp4, **Fm-Hls** (Filemoon HLS), Vn-Hls, Uni, Mp4, Ok.
- SvelteKit → there IS a JSON API (`/api/search` returns 404 *as JSON*); exact data
  routes need finding (try `__data.json`, `/api/anime/...`, network tab).
- **Next:** map the SvelteKit API; mostly hardsub hosts (Filemoon etc.) → video, not soft subs.

### anidb.app — LOW (hard-gated)
- Homepage = **403 Cloudflare "Just a moment"** → needs cloakbrowser even to load.
- User reports the UI only shows an AUDIO english/japanese toggle; servers hidden.
- **Next:** only worth it if a unique catalog; revisit with cloakbrowser.

### senshi.live — LOW (looks new/empty)
- "New Website", no catalog in static HTML, single "Server 1". Likely early-stage.
- **Next:** recheck later; not worth building now.

---

## Server-name → extractor cheat-sheet
| Server label seen on sites | Likely host / extractor | Soft subs? | Have extractor? |
|---|---|---|---|
| HD-1, HD-2, "HD" | megacloud (encrypted) **or** megaplay s-1/2/3 (unencrypted) | ✅ often (tracks[]) | megaplay ✅, megacloud ✅ |
| VidCloud, Vidstream | vidcloud / rapidcloud (megacloud family, encrypted) | ✅ often | vidcloud ✅, rapidcloud ✅ |
| VidPlay | vidplay/mycloud (vizcloud family, encrypted) | sometimes | vizcloud ✅ |
| Filemoon, Fm-Hls | filemoon (classic .sx packed-eval) | ❌ hardsub | filemoon ✅ (classic only) |
| Vidmoly, Omega | vidmoly | ❌ hardsub | ✅ (fixed) |
| Nova | nova.upn.one (AES, cracked) | ❌ hardsub | ✅ (new) |
| Doodstream | dood | ❌ hardsub | ❌ need one |
| StreamHG | streamwish/filelions family | ❌ hardsub | streamwish ✅ (maybe) |
| Earnvids | vidhide/streamwish family | ❌ hardsub | partial |
| Luf-Mp4, Vn-Hls, Uni, Mp4, Ok, Kiwi-Stream | unknown | ? | ❌ investigate |

## Recommended next target
**anineko.to** — it's the only candidate with an explicit **Soft Sub** category +
HD-1/HD-2, i.e. the best shot at *extractable simulcast captions* (the one thing
the megaplay/back-catalog path can't give us). Plan: reverse `nekovault.js`
(expect a Nova-style JSON/AES source API) to confirm HD-1/HD-2 = megacloud/megaplay
and that it returns soft EN `tracks[]`. If yes, it becomes the priority simulcast
source. reanime.to (single HD-2 server) is the easy second if HD-2 = megaplay.
