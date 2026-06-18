# SOURCES — anime site scraping tracker

Living doc for candidate anime sites: what each uses, how far we've gotten, and
what's next. Tested anime for the new batch: **Re:Zero Season 4** (some checks
used `naruto`/`rezero` side stories). Keep this updated as sites are built.

## Status legend
- ✅ **DONE** — provider/extractor built & verified in this repo
- 🟡 **TRIAGED** — recon done, not built; backend identified or partially
- 🔵 **CANDIDATE** — known, needs recon
- ⛔ **BLOCKED** — hard anti-bot / not worth it yet

## The thing we keep optimizing for: SOFT captions  — SOLVED for simulcasts
Provider-native **soft** (separate, toggleable `.vtt`) subtitles:
- **AniNeko (✅ DONE)** — Soft-Sub servers attach a separate English `.vtt` right in
  the `data-video` query string. This is the project's source of extractable
  **simulcast** captions (the long-standing gap).
- **megaplay / megacloud "HD" family** — `getSources` returns `tracks[]` incl. English
  (AnimeNoSub back-catalog → 7-language soft subs).
- Hardsub servers (Filemoon, Vidmoly, Nova, Dood, StreamHG…) burn subs in → no track.
**When a site lists "HD-1/HD-2" or a "Soft Sub" toggle, chase those for soft subs.**

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
| anineko.to | soft (200) | hianime-style clone | ✅ all browser-free | HD-1, HD-2, StreamHG, Earnvids, Doodstream | ✅ **DONE** |
| anikototv.to | soft (200) | Laravel-ish (csrf), partly JS | ✅ `/search?keyword=` (also `/filter?`) | SUB/DUB: VidPlay-1, HD-1, Vidstream-2, VidCloud-1 (+ H-SUB/A-DUB = hentai: Kiwi-Stream, Download) | MED |
| reanime.to | soft (200) | JS (`window.__`) | `/search?` (form) | SUB: HD-2, DUB: HD-2 | MED |
| mkissa.to/anime | soft (200) | **Svelte SPA** | API JSON (path TBD; `/api/search` is 404-JSON so namespace exists) | Luf-Mp4, Fm-Hls, Vn-Hls, Uni, Mp4, Ok | MED |
| anidb.app | ⛔ HARD (403 "Just a moment") | unknown (gated) | needs browser | UI only exposes AUDIO eng/jpn; servers hidden | LOW |
| senshi.live | soft (200) | SPA, "New Website" (near-empty) | none in static HTML | Hard Sub: Server 1, DUB: Server 1 | LOW |

### anineko.to — ✅ DONE (commit 94cf660) — the SOFT-SUBTITLE win
Fully **browser-free** once you use the right URL. Built `src/providers/anime/anineko.ts`
+ `src/extractors/vibeplayer.ts`, registered + aggregator FIRST.
- **The trap that cost time:** `/watch/<slug>?ep=N` is the *info* page (episode grid,
  no player). The **player is `/watch/<slug>/ep-N`** — and IT server-renders all 16
  `[data-video]` servers in plain HTML. (Found the `/ep-N` pattern via cloakbrowser
  network-capture on the VM, but production needs NO browser.)
- Search `GET /browser?keyword=` → `article.nv-anime-card a.nv-anime-thumb` `/watch/<slug>`.
- Info `GET /watch/<slug>` → `article.nv-info-episode-item a.nv-info-episode-main` → `/watch/<slug>/ep-N`.
- Player `GET /watch/<slug>/ep-N` → `[data-video]` embeds (HD-1 vibeplayer.site, HD-2
  bibiemb.xyz, StreamHG otakuhg.site, Earnvids otakuvid.online, Doodstream playmogo.com),
  in Hard-Sub / Soft-Sub / DUB variants.
- **SOFT ENGLISH SUBS:** the Soft-Sub/DUB servers carry a separate English `.vtt`
  **in the `data-video` query** (`?sub=` for vibeplayer/bibiemb, `caption_1=` for
  otakuhg/otakuvid, `c1_file=` for playmogo) on `cdn.anizara.store`. `_sub_eng` = sub,
  `_dub_eng` = dub. Fetchable server-side (200, valid WEBVTT). **No extractor needed for subs.**
- **Video:** wired HD-1 = VibePlayer (`vibeplayer.site/<id>` → m3u8 at
  `/public/stream/<id>/master.m3u8`, unencrypted, fetchable 200). Other hosts (StreamHG=
  streamwish-packed, Doodstream, etc.) are TODO fallbacks.
- Verified e2e on Re:Zero S4 ep1 (simulcast): sub & dub → m3u8 200 (360/720/1080p) + English vtt 200.

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
**anineko.to is DONE** and is now the primary source (browser-free + soft simulcast
subs). Remaining candidates, easiest-first:
- **reanime.to** — single HD-2 server; check if `/watch/<slug>/ep-N` (or similar)
  server-renders `data-video` like anineko. If HD-2 = vibeplayer/megaplay-style, quick win.
- **anikototv.to** — browser-free search; check the player URL pattern; VidCloud/Vidstream
  = megacloud family (may carry soft subs too). Note: also hosts hentai.
- **mkissa.to** — map the SvelteKit JSON API.
- **anidb.app / senshi.live** — low value (hard-gated / near-empty).

Lesson from anineko: for these clones, **find the real PLAYER url** (often `/.../ep-N`,
not `?ep=N`) — the servers are usually server-rendered there as `data-video`, and soft
subs may ride in the query string. Try plain HTTP on the player URL before assuming a
browser is needed.
