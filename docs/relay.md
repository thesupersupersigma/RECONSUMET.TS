# The video relay (`@reconsumet/relay`)

**In plain English:** neither source's video can be played by a browser straight from their servers. Re:Anime's
need a special Referer header, and AniZone's only allow `anizone.to`. So every playlist, video segment, key and subtitle
goes through the **relay**: a small separate service that fetches each file from the source and passes it on to the
viewer. The browser only ever sees `https://relay…/r/<token>.<ext>`. The token is **sealed** (encrypted and signed), so
nobody can read which upstream URL is behind it or point it anywhere else. The relay has no database: everything it
needs is inside the token. That's why it can move to another machine by changing config only.

## How a stream plays

1. The site asks the API for streams. The API seals each upstream URL (+ the headers it needs, + Re:Anime's playlist
   XOR key) into a token with the shared `RELAY_SECRET` and returns `RELAY_PUBLIC_URL/r/<token>.m3u8`. These top-level
   links expire after 10 minutes (`RELAY_TOKEN_TTL_MIN`, API side).
2. The player fetches that playlist from the relay. The relay opens the token, fetches the real playlist, decodes it if
   needed, and **rewrites every URI in it** (variants, audio/subtitle renditions, I-frame playlists, keys, init
   segments, segments, partial segments, relative / absolute / `//host` URLs) into child tokens of its own. Child links
   are relative (`<token>.ts`), so the relay works under any hostname. They live 6 hours (`RELAY_CHILD_TTL_MIN`) and
   can only be minted from a valid parent. `#EXT-X-CONTENT-STEERING` is dropped, since it would send the player upstream.
3. Segments, keys and subtitles are streamed through without buffering, with backpressure (it reads from the source
   only as fast as the viewer takes it). `Range` requests are passed on (206 answers). Only an allow-list of response
   headers is forwarded. Nothing is cached in 0.4.

Re:Anime's HD-1 links are signed for the IP that resolved them. That works while the API and relay share
one public IP. When the relay moves, set `RELAY_SHARES_EGRESS_WITH_API=false` on the API and HD-1 is no longer
offered (HD-2 works anywhere).

## Protection

- **Sealed tokens**: AES-256-GCM over `{ url, kind, expiry, headers, playlist key, source, optional viewer IP }`. Any
  change to a token makes it invalid (403). Rotation: give the relay the new `RELAY_SECRET` plus the old one as
  `RELAY_SECRET_PREVIOUS`, then switch the API to the new secret. Remove the old one after 6 hours (child token
  lifetime).
- **SSRF guard on every hop**: the relay uses `@reconsumet/core`'s fetcher with `untrusted: true`. Every URL and every
  redirect is resolved and refused if it points at a private, loopback, link-local, CGNAT (Tailscale and other CGNAT VPNs) or metadata
  address. The address checked is the one connected to.
- **CORS**: a browser request with an `Origin` outside `RELAY_ALLOWED_ORIGINS` gets 403. Allowed origins get the
  CORS headers, and preflights allow `GET`/`HEAD` + `Range`. Requests without `Origin` (native players) are allowed.
- **Limits**: at most `RELAY_MAX_STREAMS_PER_IP` (6) downloads at once per viewer IP (released on end, error and
  client abort). Bandwidth ceilings per IP (`RELAY_IP_MBPS`, 12) and, if set, in total (`RELAY_GLOBAL_MBPS`, off by default),
  as token buckets with about one second of burst, so one viewer can't eat the whole upload. Sizing them:
  [self-hosting.md](self-hosting.md#sizing-bandwidth).
  Size caps: playlists 2 MiB (and 20,000 lines), keys 64 KiB, subtitles 8 MiB, segments 64 MiB.
- Error messages never contain the upstream URL.

## Endpoints

| | |
|---|---|
| `GET\|HEAD /r/<token>.<ext>` | the relayed file. The extension only matters for subtitles: `vtt` → `text/vtt`, `ass`/`ssa` → `text/x-ssa`, `srt` → `application/x-subrip` |
| `GET /health` | `{ ok: true }` (Docker healthcheck) |
| `GET /metrics` | Prometheus text, needs `Authorization: Bearer <RELAY_METRICS_TOKEN>`; 404 when no token is set |

Metrics: `relay_bytes_out_total`, `relay_active_streams`, `relay_requests_total{kind,status}`,
`relay_upstream_errors_total{host}` (incl. failures in the middle of a body; at most 200 host labels, the rest are
counted as `other`), `relay_throttled_seconds_total`.

Errors (`{ error: { code, message } }`): `bad_token` 403, `expired` 410, `viewer_mismatch` 403, `origin_not_allowed`
403, `too_many_streams` 429, `blocked_target` 403 (SSRF), `too_large` 502, `bad_playlist` 502, `upstream` 502 (or the
upstream's own 404/416), `internal` 500.

## Measured (tsss-server, Xeon E5620 without AVX, 2026-11-24)

- **CPU: ~0.036 CPU-seconds per MB relayed ≈ 4.5 % of one core per 10 Mbit/s**, the same at 2 and 12 parallel
  viewers. tsss-server's whole 37 Mbit/s upload would cost ~17 % of one of its 16 cores. CPU is not the limit.
- Highest measured: ~57 Mbit/s sustained to a LAN client (limits raised for the test). That was limited by how fast
  the source's CDN gave us data, not by the relay.
- **The limit is the upload.** Re:Anime 1080p averages ~6.5 Mbit/s (measured on Frieren ep 1), AniZone 1080p
  ~3.5 Mbit/s (declared). With `RELAY_GLOBAL_MBPS=32`: about **4–5 Re:Anime 1080p viewers or ~9 AniZone 1080p
  viewers** at once, more at 720p. Players fetch faster than real time while filling their buffer, so the per-IP
  ceiling (12 Mbit/s) is set at roughly twice the bitrate.

Configuration: every variable is explained in [self-hosting.md](self-hosting.md#every-environment-variable).
