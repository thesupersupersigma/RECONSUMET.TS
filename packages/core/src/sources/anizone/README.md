# AniZone — recon notes (2026-11-24)

**In plain English:** AniZone puts everything we need into its pages as JSON: search results, episode lists, and
for each episode the HLS playlist URL plus every subtitle track. No crypto, no browser, no TLS impersonation. Its
video CDN no longer checks fingerprints (v1 needed curl-impersonate for it). But the CDN only allows `anizone.to` in
its CORS header, so a player on our site can't fetch the playlists or segments itself. They need a relay, though it
doesn't have to add any headers.

## Domains

`anizone.to` (everythingmoe #7), Cloudflare, no challenge. No mirror known.

## Endpoints (all `plain` tier)

AniZone is Laravel Livewire + Alpine.js. Lists are embedded as `x-data="{ items: JSON.parse('…') … }"`: a JS string
literal (Laravel `Js::from`, `"`-escaped) holding JSON.

| what | request | notes |
|---|---|---|
| search | `GET /anime?search=<q>` | `items`: `slug`, `main_title`, `title_list` (keyed by language id: 1 = English, 5 = romaji, 8 = Japanese, …), `type` (TV Series / Movie / OVA / Web / TV Special / Other), `start_year`, `episode_count`, `is_ongoing` |
| show | `GET /anime/<slug>` | `anmTitles` + the first 24 episodes in `items` (`slug` = episode number, `title_list`, `type`), `nextCursor`, `hasMore` |
| more episodes | `POST /livewire/update` | **changed since v1** (`?page=N` is gone): cursor pagination through Livewire's `loadPage(cursor)`. Needs the page's `csrf-token`, the `XSRF-TOKEN` + `anizone_session` cookies, and the component's `wire:snapshot`; the reply's `items-loaded` dispatch carries the next 24 and the next cursor. One Piece = 50 calls. |
| episode | `GET /anime/<slug>/<n>` | `vidstackPlayer(JSON.parse('…'))`: `src` (HLS master), `subtitles[]` (`title`, `format` ass/srt, `language`, `default`, `forced`, `file`), plus snapshot/storyboard/chapters URLs |

Our ids: show = slug (`y25twzsk`), episode = `<slug>/<n>`.

**Entries follow AniDB:** one entry per cour, named like AniDB ("Spy x Family (2022)" = AniList "SPY×FAMILY Part 2",
"Jujutsu Kaisen (2023)" = Season 2), each numbered from 1. The offline database lists those AniDB titles as synonyms,
which is what makes matching reliable. Offsets are needed only where AniDB merges cours AniList splits (e.g.
"Gintama. (2017)" = Porori-hen 13 + Shirogane no Tamashii-hen part 1 12).

## Video (`*.vid-cdn.xyz` and `*.xin-cdn.xyz`, e.g. `seiryuu.vid-cdn.xyz`, `suzaku.xin-cdn.xyz`)

- Master `https://<name>.vid-cdn.xyz/<uuid>/master.m3u8`: 360p/720p/1080p + **multi-audio** groups (Japanese, often
  English, German, Spanish, French, Italian, Portuguese…). So dub = select the `en` audio track; we check the master
  for one before answering `--dub`.
- Variant playlists: `#EXT-X-KEY:METHOD=AES-128,URI="../../keys/<id>.key"`, segments `video/720/00000.ts` (relative).
- Subtitles: **soft**, `.ass` and `.srt` on the same CDN (`/subtitles/<n>_<lang>.ass`), many languages (Frieren S2
  ep 1: 20+ tracks incl. forced and CC). everythingmoe notes older releases are hard-subbed (one video, no tracks).
- Both CDNs from v1 are still in use (older shows, e.g. Gintama, sit on `xin-cdn.xyz`), and neither gates any more:
  `vid-cdn.xyz` no longer resets plain TLS handshakes and `xin-cdn.xyz` no longer 403s everyone.

## Fetch tier per request (measured 2026-11-24, Windows PC, home connection)

Everything answers `plain`: site pages, Livewire, master/variant playlists, keys, segments, subtitles. Impersonation
changes nothing.

## Direct playback

Measured with `node tools/playback-check/probe.ts <url> --referer https://anizone.to/`:

| request | host | bare | ours | AniZone's Referer | CORS (`Access-Control-Allow-Origin`) |
|---|---|---|---|---|---|
| master + variant playlists | `seiryuu.vid-cdn.xyz` | 200 | 200 | 200 | `https://anizone.to` (fixed) |
| segments (.ts) | same | 200 | 200 | 200 | `https://anizone.to` |
| subtitles (.ass) | same | 200 | 200 | 200 | `https://anizone.to` |
| master, segment, subtitle | `suzaku.xin-cdn.xyz` | 200 | 200 | 200 | `https://anizone.to` |

→ No Referer, no fingerprint, but **CORS only allows anizone.to**, so hls.js on our origin can't read playlists or
segments, and the subtitle renderer can't read the `.ass` files. A relay has to re-serve them with our CORS header
(it doesn't need to add any request headers). Exception: Safari's native HLS (`<video src>` without `crossorigin`)
doesn't need CORS. That's not something to build on.

## Protections

Cloudflare, no challenge; Livewire needs the session cookie + CSRF token from the same page load. We stay at
1 request/s.
