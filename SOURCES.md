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
| reanime.to | soft (200) | **SvelteKit** + REST API | ✅ `/api/v1/search?q=` (browser-free) | HD-2 = flixcloud.cc | 🟡 **PARTIAL** (subs ✅, video crack pending) |
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

### reanime.to — 🟡 PARTIAL (subs DONE, video crack PENDING) — built `reanime.ts`
**SvelteKit site with a clean, browser-free REST API.** Built
`src/providers/anime/reanime.ts` + `src/extractors/flixcloud.ts`, registered in
anime index + providers-list. **NOT in the aggregator default chain yet** (no video).
- Stack signature: `/assets/immutable/` = SvelteKit. Search results render
  client-side; the real data is a REST API:
  - Search:   `GET /api/v1/search?q=<query>&limit=20` → `results[].anime_id` (slug),
    AniList-backed (`cover_image` = `anilistcdn/.../bx<anilistId>-…jpg`).
  - Episodes: `GET /api/v1/anime/<slug>/episodes?limit=2000` → `data[].episode_number`.
  - Metadata: `GET /api/v1/watch/<slug>?ep=1` → title/cover (+ AniList id via the `bx…` url).
  - **Servers: `GET /api/flix/<ANILIST_ID>/<ep>`** → `{success,servers:[{serverName:"HD-2",
    dataLink:"https://flixcloud.cc/e/<id>?v=2",dataType:"sub|dub"}]}`. (Keyed by AniList
    media id — which our aggregator already knows. Response can append trailing bytes;
    parse `dataLink`/`dataType` with a regex, not strict JSON.)
- **SOFT SUBS = the win (DONE):** the flixcloud embed ships a SvelteKit data payload
  with a plain, **unencrypted** `subtitles:[{url,language,format:"ass"}]` array of
  `.ass` files on `*.overcdn.site` (fansub/Aegisub-grade, styled — e.g. "English (Full
  Subtitles)"). `FlixCloud` extractor regexes them out: `url:"…\.ass",language:"…"`.
  Verified e2e on Re:Zero S1 ep1 → 2 English `.ass` tracks (200, valid Aegisub). These
  are higher-quality/styled vs the `.vtt` we get elsewhere → also a candidate
  **subtitle-supplement** source for other providers' video later.

#### ⛔ flixcloud stream crack — PENDING (do on high/xhigh when usage is good)
The m3u8 is behind a **megacloud-tier** wall (deliberate, rotating). Recovered
client-side in `flixcloud.cc` node `11.HnY02FpX.js`, fn `Se()`. Full recipe:
1. **Deobfuscate field names** with `obfuscation_seed` (fn `_e(seed)` resolves the
   randomized keys in the inline `data` payload).
2. **Token round-trip**: fetch `/api/…` (the `fetch(` in node 11) → returns more
   crypto material (`frag1_b64` + token fragments `v`,`T`). ("Incomplete token response".)
3. **WASM cipher** `w_payload` (base64, 279 bytes; exports `_s`,`_r`,`_c`) — ALREADY
   DECODED, fully portable to JS, no wasm needed:
   - `_s(x)` → sets `seed` global.
   - `_r(A,B,C,Out,len)`: `for i: v=A[i]^B[i]^C[i]; v^=0x48; v=((v<<2)|(v>>6))&0xFF; v^=0xF2; v^=((i*60+seed)&0xFF); Out[i]=v`.
   - `_c()`: `for i in 0..32: mem[0x810+i]=mem[0x7D0+i]^mem[0x7F0+i]` (returns 0x810; this
     path feeds `window.__pk`). seed `_ = parseInt(obfuscation_seed.substring(0,8),16)`.
   - Call shape in `ke(t,e,s,o)`: writes t@1000, e@2000, s@3000, calls `_s(seed)` then `_r`.
4. **PBKDF2**: `crypto.subtle.importKey("raw", E, {name:"PBKDF2"}, …deriveBits)` on the
   WASM output `E`.
5. **AES-256-CBC** decrypt the manifest (`obfuscated_crypto_data.…{kf_*=key, ivf_*=iv,
   metadata.encoding:"aes256cbc"}`) → the m3u8 URL (TextDecoder).
- Saved artifacts (regenerate if site rotates): node 11 = `flixcloud.cc/res/immutable/nodes/11.HnY02FpX.js`;
  WASM = the `w_payload` base64 in any embed's inline data.
- When done: implement in `flixcloud.ts` (fill `sources`), then add `ReAnime` to the
  aggregator default array in `meta/aggregator.ts`.

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
| HD-2 (reanime) | flixcloud.cc | ✅ **soft `.ass`** (free) | subs ✅; video crack pending (WASM+PBKDF2+AES+token) |
| Doodstream | dood | ❌ hardsub | ❌ need one |
| StreamHG | streamwish/filelions family | ❌ hardsub | streamwish ✅ (maybe) |
| Earnvids | vidhide/streamwish family | ❌ hardsub | partial |
| Luf-Mp4, Vn-Hls, Uni, Mp4, Ok, Kiwi-Stream | unknown | ? | ❌ investigate |

## Recommended next target
**anineko.to is DONE** and is now the primary source (browser-free + soft simulcast
subs). **reanime.to is PARTIAL** (browser-free API + free `.ass` soft subs built;
flixcloud video crack pending — see its section). Remaining candidates, easiest-first:
- **reanime.to flixcloud crack** — the one big-ticket item; do on high/xhigh when
  usage is good. Full decoded recipe is in the reanime section above.
- **anikototv.to** — browser-free search; check the player URL pattern; VidCloud/Vidstream
  = megacloud family (may carry soft subs too). Note: also hosts hentai.
- **mkissa.to** — map the SvelteKit JSON API.
- **anidb.app / senshi.live** — low value (hard-gated / near-empty).

Lesson from anineko: for these clones, **find the real PLAYER url** (often `/.../ep-N`,
not `?ep=N`) — the servers are usually server-rendered there as `data-video`, and soft
subs may ride in the query string. Try plain HTTP on the player URL before assuming a
browser is needed.
