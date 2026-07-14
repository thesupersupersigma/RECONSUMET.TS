# SOURCES — anime site scraping tracker

## ⚠️ READ THIS FIRST — status correction (see full history below)

This doc's history below (mkissa.to marked ⛔ SKIP, no AnimePahe entry, "cloakbrowser is
no longer deployed") reflects real, accurate investigative work **at the time it was
written** — but two of its conclusions are now **superseded** and should not be trusted
at face value without reading this correction first:

- **mkissa.to is now ✅ DONE, not ⛔ SKIP.** The blocker documented below (AllAnime's
  Cloudflare JS/Turnstile challenge, confirmed un-passable by curl-impersonate alone) was
  real and correctly diagnosed. What changed: **Byparr** (a maintained, actively-developed
  FlareSolverr-compatible headless-browser solver) was stood up specifically to clear this
  exact challenge tier — confirmed working via a live cf_clearance solve, verified reusable
  outside the solver. `mkissa.ts` is built, wired, and verified end-to-end (real playable
  video for both sub and dub). See the "Byparr / Cloudflare Managed Challenge" section below
  for the full build.
- **AnimePahe is now ✅ DONE.** Was always the top-priority target but had no entry in this
  doc's original candidate table — it's built via the same Byparr infrastructure as mkissa.to.
- **"cloakbrowser is no longer deployed"** (below) is still true and *unrelated* to the
  above — cloakbrowser was a different, older browser dependency (for Gogoanime, which
  turned out not to need a browser at all) and stays fully removed. Byparr is a distinct,
  new, currently load-bearing dependency for exactly two sources (AnimePahe, mkissa.to).
  Don't conflate "no cloakbrowser" with "no browser dependency at all" — that's no longer
  true.

**The lesson, stated plainly so it doesn't get re-learned the hard way a third time:**
this project has now twice carried forward a stale "X needs a browser" / "X is blocked"
assumption across sessions without re-verifying it against the live site or against new
tooling that became available since (Byparr didn't exist as an option when mkissa.to was
first marked ⛔). Before treating any status below as current, check whether it's been
superseded here first, and when genuinely unsure, re-verify live rather than trust either
this doc or your own memory of it.

## Byparr / Cloudflare Managed Challenge (AnimePahe + mkissa.to) — ✅ DONE

Both sites sit behind Cloudflare's Managed Challenge (Turnstile/JS-VM tier). Confirmed
this tier hard-blocks: (a) plain HTTP clients, and (b) curl-impersonate/TLS-fingerprint
spoofing alone — the TLS layer can pass, but the JS/Turnstile challenge itself can't be
executed without a real browser. FlareSolverr (the original, more widely-known tool for
this) was tried first and confirmed **unable** to solve this specific challenge version —
its title-polling/checkbox-click solving logic doesn't clear the invisible Turnstile
widget, and the project is effectively unmaintained. **Byparr** (github.com/ThePhaseless/
Byparr), a genuine drop-in FlareSolverr-API-compatible replacement built on Camoufox
(a more deeply fingerprint-patched Firefox), was deployed instead and confirmed working —
solves in ~13-15s cold, returns a real, reusable `cf_clearance` cookie + matching
User-Agent (verified reusable via a plain curl request outside the solver itself, with a
clean negative-control test: same request without the cookie → 403, with it → 200).

Shared infrastructure: `consumet/src/utils/cf-solver.ts` (`CloudflareSolver` + `http2Get`)
was built generic and provider-agnostic specifically so both AnimePahe and mkissa.to could
reuse it as-is — confirmed working for both without modification. It solves an origin
once via Byparr's `/v1` endpoint, caches the `cf_clearance` + UA pair per-host in a
process-wide map, reuses it on fast subsequent requests, and auto re-solves + retries once
on a `403` (cookie expiry/rotation) — no manual intervention needed.

**Load-bearing discovery, applies to both providers**: the entire AnimePahe pipeline
(main site, kwik embed host, and the `uwucdn.top` video CDN) turned out to be
**HTTP/2-only** — a valid `cf_clearance` cookie will still `403` over plain HTTP/1.1,
which is what Node's default `axios`/`fetch` use. This was a genuinely subtle bug that
initially looked like it "worked" in manual `curl` testing, because `curl` defaults to
HTTP/2 (masking the problem) — only caught by testing the actual code path, not just a
manual reproduction. Fixed via Node's built-in `http2` module (`http2Get`, part of
`cf-solver.ts`), used by both the solver itself and the kwik-embed unpacker. mkissa.to's
own hosts were separately checked for the same HTTP/2-only pattern (not assumed just
because AnimePahe had it) — resolved differently per-host, see each provider's own
section below for specifics if this doc gets updated further.

Operational note: Byparr spawns real Camoufox (Firefox-based) browser instances per cold
solve, which can leave **zombie child processes** (`Socket Process`, `RDD Process`,
`Utility Process` — Chromium/Firefox-internal subprocess types) accumulating over hours of
heavy use if not cleanly reaped — this contributed to a real VM-wide memory/CPU incident
during the build session. Mitigated with a Docker memory cap
(`docker update --memory=3g --memory-swap=3g flaresolverr` — the container is kept under
that name for drop-in compatibility) and a scheduled `docker restart flaresolverr` cron
job (every 12h) as a periodic cleanup. The underlying zombie-accumulation behavior itself
was not fixed at the Byparr level, only capped in blast radius.

---

Living doc for candidate anime sites: what each uses, how far we've gotten, and
what's next. Tested anime for the new batch: **Re:Zero Season 4** (some checks
used `naruto`/`rezero` side stories). Keep this updated as sites are built.

## Status legend
- ✅ **DONE** — provider/extractor built & verified in this repo
- 🟡 **TRIAGED** — recon done, not built; backend identified or partially
- 🔵 **CANDIDATE** — known, needs recon
- ⛔ **BLOCKED** — hard anti-bot / not worth it yet

**cloakbrowser is no longer deployed** (`browser-fetcher.ts` deleted; Gogoanime's episode
list moved to plain HTTP — its AJAX nonce/params turned out to be readable straight off the
raw page HTML, no JS execution required). Any note below that says "revisit with
cloakbrowser" means a real headless-browser CF/Turnstile solver would need to be stood up
again from scratch for that specific site; it's not a flag you can just flip back on.

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
| anikototv.to | soft (200) | zoro/hianime clone on **nekostream** backend | ✅ `/search?keyword=` (browser-free) | HD-1=megaplay (soft EN subs), VidPlay/Vidstream/VidCloud, Kiwi-Stream=vibeplayer | ✅ **DONE** |
| reanime.to | soft (200) | **SvelteKit** + REST API | ✅ `/api/v1/search?q=` (browser-free) | HD-2 = flixcloud.cc | ✅ **DONE & PLAYABLE** (crack + curl-impersonate proxy; in aggregator) |
| mkissa.to/anime | ⛔→✅ **DONE (see correction at top of doc)** | **SvelteKit SPA = AllAnime frontend** | client calls `api.allanime.day` directly (no server proxy) | AllAnime: Luf-Mp4, Vn-Hls, Uni, Ok… | ✅ **DONE** — see top-of-doc correction; the CF blocker below was real but is now cleared via Byparr |
| anidb.app | ⛔→✅ **DONE (see correction at top of doc)** | unknown (gated) | needs browser | UI only exposes AUDIO eng/jpn; servers hidden | ✅ **DONE** — genuinely multi-server, real independent host; the "content indexing service" disclaimer on the live site turned out to be false, see full build notes elsewhere |
| senshi.live | soft (200) | SPA, "New Website" (near-empty) | none in static HTML | Hard Sub: Server 1, DUB: Server 1 | ✅ **DONE** — reverse-engineered live, real REST API, genuinely multi-server, both sub+dub fully playable |

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

### anikototv.to — ✅ DONE — built `anikototv.ts` (browser-free, reuses MegaPlay + VibePlayer)
Zoro/hianime clone sitting on the shared **nekostream** backend (same family as
AniNeko). Fully browser-free. `/ajax/server?get=` does all the decryption server-side
→ resolves to embeds we already extract. **No new crack.** Built `src/providers/anime/anikototv.ts`,
registered + added to the aggregator default chain. Verified e2e on Re:Zero S4 ep1:
4 m3u8 variants (200) + English soft `.vtt` (200).
- **Chain (all plain HTTP):**
  1. Search `GET /search?keyword=<q>` → `a.name.d-title` → `/watch/<slug>/ep-1`.
  2. AnimeId: `GET /watch/<slug>/ep-1` → `#watch-main[data-id]` (e.g. 8738).
  3. Episodes: `GET /ajax/episode/list/<animeId>` → `a[data-num]` anchors, each with an
     encrypted **`data-ids`** blob (the per-episode server key) + `data-mal`.
  4. Servers: `GET /ajax/server/list?servers=<data-ids>` → `.type[data-type=sub|dub] li[data-link-id]`.
  5. Embed: `GET /ajax/server?get=<link-id>` → `{result:{url}}` (host decrypts the blob).
- **Embeds resolve to extractors we have:**
  - **HD-1 → `megaplay.buzz/stream/s-5/<id>/<sub|dub>`** → MegaPlay → HLS + **English soft subs** (tracks[]).
  - **Kiwi-Stream → `mewcdn.online/player/plyr.php#<b64>#`** where b64 decodes to a
    `vibeplayer.site/public/stream/<id>/master.m3u8` → VibePlayer. (mewcdn wrapper =
    `plyr.php#<base64 inner url>#`; the provider unwraps any `#<b64>#`.)
  - VidPlay/Vidstream/VidCloud = other nekostream hosts (megacloud family); HD-1 is
    preferred (soft subs) so they're untested fallbacks.
- **Note:** an alternative server source exists at `mapper.nekostream.site/api/mal/<mal>/<slug>/<timestamp>`
  (returns the same `MTF…` link-id blobs, incl. a "Kiwi-Stream" with `pahe.nekostream.site` downloads).
  We don't need it — the native `/ajax/server/list` already returns working link-ids.

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

#### ✅ flixcloud stream crack — DONE (implemented in `flixcloud.ts`)
The m3u8 was behind a megacloud-tier, self-rotating wall (`flixcloud.cc` node
`11.HnY02FpX.js`, fn `Se()`). **Fully reversed & implemented**, browser-free.
Verified e2e: decrypts to a valid signed `master.m3u8`. The exact pipeline:
1. **Field-name deobfuscation** from `obfuscation_seed`: `e = sha256-chain(seed,"0","1","2")`
   then `s = sha256-chain(e,"0","1","2")` (each step `sha256(prev+i)`, hex). Field names:
   `kf_${e[8:16]}` (frag1/key), `ivf_${e[16:24]}` (iv), tokenField `${e[48:64]}_${e[56:64]}`,
   keyFrag2Field `${s[0:16]}_${s[16:24]}`. (The `cd_/ad_/od_` container path also derives
   from `e[24:32]/[32:40]/[40:48]` but we just grab `kf_*`/`ivf_*` values by regex.)
2. **Token round-trip**: `GET https://flixcloud.cc/api/m3u8/<tokenRef>` → JSON keyed by
   hashes: `v = y[sha256(tokenRef+"vid")[:10]]` (AES-encrypted manifest, b64),
   `T = y[sha256(tokenRef+"key")[:10]]` (key fragment 3, b64).
3. **WASM cipher** `w_payload` (exports `_s`/`_r`/`_c`): we **instantiate the site's own
   module** (Node `WebAssembly`) — robust to constant tweaks. Layout A@1000,B@1000+k,
   C@1000+2k,Out@1000+3k; `_s(parseInt(seed[:8],16)); _r(A,B,C,Out,k)`. Inputs A=frag1,
   B=keyFrag2 (`r.data[keyFrag2Field]`), C=frag3(T). (`_r` logic for reference:
   `v=A^B^C; v^=0x48; rotl2; v^=0xF2; v^=((i*60+seed)&0xFF)`.) → 32-byte `E`.
4. **Key**: `PBKDF2(E, salt=utf8(seed), 1000, SHA-256, 32B)` → xor each byte with
   `seed[i%len]` → SHA-256 → AES-256 key.
5. **AES-256-CBC** decrypt `v` (iv = `ivf_*` value) → final URL on `fetch5.flixcloud.cc`.

**Two more playback-time gates — both SOLVED in the `/proxy`:**
1. **CF/JA3 TLS gate.** `fetch5.flixcloud.cc/_v7/<id>/master.m3u8?token=<JWT>` (JWT
   IP-locked ~6h) **and the segment host `*.overcdn.site`** (segments are disguised as
   `.ttf`, first byte `0x47` = MPEG-TS) both 403 plain node. Beaten with
   **curl-impersonate** + a *fetch*-style header set (`Sec-Fetch-*: cors/empty`,
   `Origin`, `Accept: */*` — navigation-style headers alone still 403, that was the
   gotcha). NOTE: the embed host `flixcloud.cc` and the **subtitle** path on overcdn are
   not gated, but the **segment** path on overcdn IS → impersonate `overcdn.site` too.
2. **Playlist XOR obfuscation.** Each playlist body comes back base64 (NOT `#EXTM3U`),
   XOR'd with a **per-video 32-byte key** = `window.__pk` (the WASM `_c()` export):
   `plain[i] = b64dec(body)[i] ^ pk[i%32]`. The patched hls.js does this in-browser; we
   replicate it in the proxy. The extractor returns `pk` (ISource.pk); `/watch` threads
   it as `&pk=` and `rewriteM3U8` propagates it to child playlists.
- **Status: PLAYABLE end-to-end.** `flixcloud.ts` returns m3u8 + `pk` + `.ass` subs;
  `api/src/server.mjs` `/proxy` impersonates `TLS_IMPERSONATE_HOSTS`
  (`flixcloud.cc,overcdn.site`) via `CURL_IMPERSONATE_BIN` and de-obfuscates playlists.
  `ReAnime` is now in the aggregator default chain (after AnikotoTV). Verified e2e
  (real server + curl_cffi shim): master/variant playlists 200+deobfuscated, TS segment
  200 (133 KB, `0x47`), `.ass` sub 200.

### mkissa.to — ✅ DONE (2026-07-13) — SUPERSEDES the "⛔ SKIP" verdict below
**This site's diagnosis below was accurate at the time — the CF blocker was real and
correctly identified.** What changed: Byparr (a maintained FlareSolverr-compatible
headless-browser solver, not available/considered when this was first written) was
deployed and confirmed able to clear AllAnime's exact Cloudflare Managed Challenge tier.
`mkissa.ts` reuses the shared `cf-solver.ts` (built generic for AnimePahe, confirmed
working here unmodified) and is verified end-to-end with real playable video for both
sub and dub. See the top-of-doc correction section for the full build summary. The
technical analysis below (AllAnime backend, decoy endpoints, the real
`api.allanime.day` GraphQL API) remains accurate and was the actual reference used to
build the real provider — only the "can't get past Cloudflare" conclusion is superseded.

**Original diagnosis (accurate at the time, kept for reference):**
Recon'd (this session). mkissa.to is a **SvelteKit SPA that is just a skin over AllAnime**
— the server names (Luf-Mp4, Vn-Hls, Uni, Ok) are AllAnime's, and the bundle's real config
is `Le = "https://api.allanime.day/api"` (GraphQL: `shows`/`episode`/`sourceUrls`/
`translationType`), embeds on `allanime.day/embed`, images `cdn.allanime.day`. The
`allanimenew.com`/`getLinks?id=<fake-hex>` strings in the bundle are **decoys**.
- **No server-side proxy:** mkissa's SSR pages + `__data.json` are empty shells; the
  catalog loads **client-side by calling `api.allanime.day` directly**. So scraping mkissa
  buys nothing over hitting AllAnime itself.
- **The blocker = AllAnime's Cloudflare gate.** `api.allanime.day` returns a full
  **"Just a moment" JS/Turnstile challenge** — verified that BOTH plain fetch AND
  **curl-impersonate (chrome124) get 403**. So it's not a TLS/JA3 gate (our proxy can't fix
  it); it needs a real browser to solve the JS challenge + a `cf_clearance` cookie
  (IP/UA-bound, short-lived). NOTE: CF here is partly IP-reputation — ani-cli works from
  many residential IPs; a datacenter VM (Oracle) likely gets challenged.
- **Verdict:** not a browser-free source. Skip unless we deliberately want AllAnime via
  **cloakbrowser** (solve challenge once, harvest `cf_clearance`, replay with matching
  UA + curl-impersonate TLS). That re-introduces the browser dependency for one source and
  is fragile — low ROI given we already have 4 working browser-free sources. AllAnime's
  source-link decode (hex `--`-prefix → XOR 56 → `/apivtwo/clock` → links) is the easy part;
  the CF gate is the hard part.

### anidb.app — ✅ DONE (2026-07-13) — SUPERSEDES the "LOW/hard-gated" verdict below
**Genuinely multi-server, real independent host** (`hls.anidb.app`) — one server per
audio language (Japanese/English), resolved in parallel. Its metadata layer IS
Cloudflare-TLS-gated as noted below, but is cleared via `curl-impersonate` (not a
headless browser — this is a TLS/JA3 fingerprint gate, not a full JS/Turnstile
challenge, a meaningfully lighter problem than AnimePahe/mkissa.to's Managed Challenge).
`anidb.app`'s own site footer claims to be a "content indexing service" that doesn't
host video — **confirmed FALSE** by tracing an actual video request end-to-end: no
third-party embed appears anywhere in the real chain, only `anidb.app`/`hls.anidb.app`
hosts are ever touched. Treat that disclaimer as DMCA-liability boilerplate, not an
accurate technical description. `.xls`-disguised segments (real MPEG-TS, fake
extension) are handled correctly by the already-extension-agnostic `/proxy`.

**Original assessment below (accurate observation — 403 "Just a moment" — but the
conclusion "needs browser" undersold it; curl-impersonate alone turned out to suffice):**
### anidb.app — LOW (hard-gated)
- Homepage = **403 Cloudflare "Just a moment"** → needs cloakbrowser even to load.
- User reports the UI only shows an AUDIO english/japanese toggle; servers hidden.
- **Next:** only worth it if a unique catalog; revisit with cloakbrowser.

### senshi.live — ✅ DONE (2026-07-13) — SUPERSEDES the "LOW/looks empty" note below
Turned out to be a real, healthy React/Vite SPA with a plain JSON REST API — no anti-bot
at all on any path. Genuinely multi-server per audio type, both sub and dub fully
playable (not a metadata-only phantom). One real caveat: subtitles are burned-in
hardsubs, no separate soft `.vtt` track. The "looks new/near-empty" read below was based
on an incomplete initial look — a full from-scratch build found a real, working site.

**Original note (superseded):**
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
- **reanime.to flixcloud** — ✅ DONE & PLAYABLE (decryption + curl-impersonate proxy +
  playlist XOR deobfuscation; in the aggregator). Nothing left here.
- **curl-impersonate proxy** (project-wide) — ✅ shipped in `api/src/server.mjs`. Now
  available to harden any other Referer-locked/CF-fronted CDN: just add its host to
  `TLS_IMPERSONATE_HOSTS`. (If the megaplay CDN ever re-gates, this is the fix.)
- ~~**mkissa.to**~~ — ⛔ ruled out: it's an AllAnime client-side frontend, and AllAnime is
  behind a CF JS/Turnstile challenge (curl-impersonate can't pass; needs a browser). See above.
- **anidb.app / senshi.live** — low value (hard-gated / near-empty).

Lesson from anineko: for these clones, **find the real PLAYER url** (often `/.../ep-N`,
not `?ep=N`) — the servers are usually server-rendered there as `data-video`, and soft
subs may ride in the query string. Try plain HTTP on the player URL before assuming a
browser is needed.
