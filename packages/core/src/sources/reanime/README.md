# Re:Anime — recon notes (2026-11-24)

**In plain English:** Re:Anime has a clean JSON API keyed by AniList IDs, so finding the right show needs no
guesswork. Its video host, FlixCloud, still hides the playlist URL behind the same crypto v1 cracked: we decrypt it
ourselves, no browser needed. Everything works over plain HTTPS (no TLS impersonation). The catch for playback: the
video segments refuse any request without FlixCloud's Referer, so a browser on our site can't load them directly.
They have to go through a relay.

## Domains

| domain | status (2026-11-24) |
|---|---|
| `reanime.cz` | main site (everythingmoe #1), Cloudflare, no challenge |
| `reanime.bz`, `reanime.wtf` | same site, 200 |
| `reanime.to` | 301 → `reanime.cz` (v1's domain) |

## Endpoints (all `plain` tier, no headers needed)

| what | request | notes |
|---|---|---|
| search | `GET /api/v1/search?q=<q>&limit=20` | results carry `anilist_id`, `anime_id` (slug), titles, format, `season_year`, `episodes`, `subbed`/`dubbed` counts |
| episodes | `GET /api/v1/anime/<slug>/episodes?limit=2000` | one request even for One Piece (1180); `episode_number`, `title`, `subbed`, `dubbed`, `playable` |
| watch | `GET /api/v1/watch/<slug>?ep=1` | metadata; **no AniList ID field any more**, read it from the AniList cover URL (`…/bx154587-….jpg`) |
| servers | `GET /api/flix/<anilistId>/<ep>` | `{ servers: [{ serverName: HD-1/HD-2, dataLink: flixcloud.cc/e/<id>?v=1/2, dataType: sub/dub }] }` |

Our ids: show = `<anilistId>/<slug>`, episode = `<anilistId>/<episode>`. Episode numbers are per AniList entry, so
the match is always exact and the offset always 0.

## FlixCloud (`extractors/flixcloud.ts`)

- Embed `https://flixcloud.cc/e/<id>?v=<1|2>` (Referer `reanime.cz`). SvelteKit page; the real fields hide among ~25
  decoy hex-named fields. **The v1 scheme is unchanged** (field names from chained SHA-256 of `obfuscation_seed`,
  token round-trip `GET /api/m3u8/<tokenRef>`, the page's 460-byte WASM `_s/_r/_c`, PBKDF2 → AES-256-CBC). The seed
  is now 16 hex characters; only the first 8 feed the WASM, as before.
- **Sub and dub are the same embed.** The master has two audio groups (`jpn` "Native", `eng` "English"), so dub =
  select the `eng` audio track (`audioLang` on the stream).
- **HD-2** (`?v=2`): master on `fetchN.flixcloud.cc/_v8/<opaque>/master.m3u8`, no token in the query.
- **HD-1** (`?v=1`): master on `fetchN.flixcloud.cc/_v7/<videoId>/master.m3u8?token=<JWT>`. The JWT carries
  `client_ip` = **the IP that resolved it** (ours) and a 6 h expiry. So HD-1 only plays through a relay on the same IP,
  and handing that URL to a browser leaks the server's IP. We list HD-2 first; the stream has `ipLocked: true`.
- Playlists come back **base64 + XOR** with a 32-byte per-video key (WASM `_c()`), returned as `playlistKey`; the 0.4
  proxy must decode every playlist (`decodePlaylist()`). Segments and keys are plain.
- Variant playlists: `#EXT-X-KEY:METHOD=AES-128,URI="key.bin"` (key next to the playlist on fetchN.flixcloud.cc),
  segments on other hosts and disguised as images: `vault-NN.vertexcdn.site/…/seg-0-….webp|.png` (HD-2),
  `vault-NN.rundowncdn.top/…/seg-….png` (HD-1).
- Subtitles: **soft** — `.ass` (fansub-grade, styled, with font files), `.srt` ("Dubtitle (AI)"), up to ~17 languages, on
  `fetchN.subtites4you.com` (fallback host `vault-94.valorcdn.site`). Chapters give intro/outro times.
- v1's gated hosts are gone: `overcdn.site` doesn't resolve (brainstorm 0.1); subtitles moved to `subtites4you.com`,
  segments to `vertexcdn.site` / `rundowncdn.top`.

## Fetch tier per request (measured 2026-11-24, Windows PC, home connection)

Everything answers the `plain` tier. TLS impersonation changed nothing anywhere (same status with and without).

## Direct playback (could a player on our site load it itself?)

Measured with `node tools/playback-check/probe.ts <url> --referer https://flixcloud.cc/`, which tries each URL with no
Referer/Origin ("bare"), with a browser's cross-origin headers from our site ("ours"), and with FlixCloud's own.

| request | host | bare | ours | FlixCloud's Referer | CORS |
|---|---|---|---|---|---|
| master + variant playlists | `fetch8/9.flixcloud.cc` | 200 | 200 | 200 | `*` |
| AES key `key.bin` | `fetch8.flixcloud.cc` | 200 | 200 | 200 | `*` |
| segments | `vault-92.vertexcdn.site`, `vault-94.rundowncdn.top` | **403** | **403** | 200 | `*` |
| subtitles (.ass/.srt) | `fetch1/2.subtites4you.com` | 200 | 200 | 200 | `*` |

→ Playlists, keys and subtitles could load directly (once our proxy has decoded the XOR'd playlists, so in practice
playlists go through the proxy anyway). **Segments need the Referer, so they need a relay.** No fingerprint gate.
HD-1 additionally needs the relay to be on the IP that resolved the URL.

## Protections

Cloudflare in front of everything, no challenge. No login, no CAPTCHA. Rate: we stay at 1 request/s per host.
