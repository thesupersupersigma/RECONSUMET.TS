# Report — task 04: API, signed video relay, Postgres, Docker (→ v0.4.0)

Date: 2026-11-24. Author: thesupersupersigma (work done by Claude Code, with two Opus subagents for `db` and
`relay`). Committed as I went; nothing pushed. Offline tests ran on the **Windows PC**; the Docker stack, migrations,
the live end-to-end test against it and the throughput measurements ran on **tsss-server** (everything I started
there has been removed again).

## Plain-English summary

- **RECONSUMΣT.TS is now a service.** Two Docker images from one Dockerfile: the **API** (AniList ID + episode →
  streams, search, episode lists, OpenAPI docs at `/docs`, API keys, rate limits, its own Postgres, scheduled jobs)
  and the **relay** (serves every playlist, video segment, key and subtitle to the viewer). The site gets a typed
  client package (`@reconsumet/client`).
- **The browser never sees a source URL.** Every stream/subtitle link the API returns is `relay/r/<token>.<ext>`, and
  the token is encrypted (AES-256-GCM), so it can't be read or changed. Re:Anime's HD-1 links, which contain the
  resolver's IP, stay hidden too.
- **It plays, live, for both sources:** API → streams → master playlist → variant → AES key (AniZone) → two real
  segments (MPEG-TS confirmed, after decrypting AniZone's) → subtitle, all through the relay. That ran both
  in-process on the PC and against the real Docker stack on tsss-server, for Re:Anime HD-2 **and** HD-1 and for
  AniZone.
- **tsss-server runs it fine:** both images build in about a minute, no "Illegal instruction" on the no-AVX Xeons
  (incl. the native TLS-impersonation module), migrations + the full catalog import (41,543 entries) take ~26 s.
- **CPU isn't the bottleneck, the home upload is.** The relay costs ~4.5 % of one Xeon core per 10 Mbit/s. Re:Anime
  1080p averages ~6.5 Mbit/s, so tsss-server's 37 Mbit/s upload (relay cap 32 Mbit/s) serves **~4–5 Re:Anime 1080p
  viewers or ~9 AniZone 1080p viewers** at once. That matches brainstorm 1.26's estimate.
- **Not done / for you:** the deployment itself (step-by-step in `docs/deploy.md`: Postgres user, two Coolify apps,
  a DNS-only record, port forward 443 **and 80**), and 1.2 GB of Docker build cache I left on tsss-server (see
  "tsss-server").

## What runs

| Package | What | Tests (offline, PC) |
|---|---|---|
| `@reconsumet/core` | + sealed relay tokens (`sealToken`/`openToken`, key rotation), `clientIp` behind trusted proxies, AniList cache and mapping store made pluggable, per-host concurrency setting | 162 ✓ |
| `@reconsumet/db` | Drizzle schema + 2 SQL migrations; Postgres `CatalogStore`, mapping/override store, TTL cache, API keys, health history, job runs + advisory locks | 11 ✓ (PGlite) |
| `@reconsumet/api` | Hono + zod-openapi; 6 routes; keys; per-IP/per-key limits; jobs; admin CLI | 13 ✓ (PGlite) |
| `@reconsumet/relay` | token relay, HLS rewriting, Range, size caps, CORS, per-IP streams, bandwidth buckets, `/metrics` | 23 ✓ |
| `@reconsumet/client` | `hc<AppType>` client + zod schemas | 1 ✓ (against the real app) |

**210 offline tests pass** (`pnpm test`, PC). `pnpm build`, `pnpm typecheck` and `pnpm lint` are clean.

Covered by tests: every route with PGlite, the one error format, OpenAPI `servers` from config (not `Host`), key
required for streams, bad/revoked keys, per-IP and per-key 429 + `retry-after`, `X-Forwarded-For` honoured only from
trusted proxies, HD-1 dropped when `RELAY_SHARES_EGRESS_WITH_API=false`, no upstream host anywhere in a streams
answer, stream-answer caching, job "due"/lock/retry logic, token seal/open/expiry/rotation/tamper, playlist rewriting
(masters, `EXT-X-MEDIA`, I-frame, `KEY`/`SESSION-KEY`/`METHOD=NONE`, `MAP`, `PART`/`PRELOAD-HINT`, relative /
absolute / `//host`, CRLF, content-steering dropped, line cap), XOR'd playlists, Range → 206, size cap → 502, SSRF on
a redirect hop, CORS allow/deny/preflight, stream slot released on client abort, bandwidth limiter math, `/metrics`
auth.

## Live end to end through the relay

`pnpm test:live` in `packages/api` (`test/e2e.live.test.ts`). Frieren (AniList 154587) episode 1, sub, every server:

| Where | Source / server | Segments 0, 1 (bytes, time through relay) | Format | Subtitle |
|---|---|---|---|---|
| PC, in-process | Re:Anime HD-2 | 2,658,132 / 4,201,236 | MPEG-TS | ✓ |
| PC, in-process | Re:Anime HD-1 (IP-locked) | 2,658,132 / 4,201,236 | MPEG-TS | (same track) |
| PC, in-process | AniZone | 611,188 / 473,760 (AES-128, decrypted with the relayed key) | MPEG-TS | ✓ |
| **tsss-server Docker stack**, test from the PC over the LAN | Re:Anime HD-2 | same, 696 ms / 873 ms | MPEG-TS | ✓ |
| ″ | Re:Anime HD-1 | same, 644 ms / 953 ms | MPEG-TS | |
| ″ | AniZone | same, 185 ms / 174 ms | MPEG-TS | ✓ |

On the PC, segment 1 of Re:Anime took ~2.8 s = ~11.7 Mbit/s: the per-IP 12 Mbit/s ceiling doing its job. For the
tsss-server run the limits were raised.

## tsss-server (no deploying; everything removed afterwards)

Done over the LAN as `thesupersupersigma`, in `~/reconsumet-e2e`, compose project `reconsumet-e2e`. API and relay
bound to `10.0.0.140:38080/38081`, Postgres to `127.0.0.1:35432`, throwaway random secrets.

- `docker compose build`: both images in **~60 s**. Sizes: api 445 MB, relay 377 MB.
- All three containers **healthy**. `grep -ci "illegal instruction"` over all logs: **0**. Native `wreq-js` inside
  the API container made an impersonated request to tls.peet.ws: HTTP 200, Chrome JA4.
- Migrations on start + `node dist/cli.js migrate` (one-shot, idempotent) + `keys create`/`keys list` work.
- First job round against real Postgres 17: `catalog-update` 26.4 s (41,543 entries), `anilist-sync` 6.4 s,
  `source-health` 0.6 s, `cache-prune` 3 ms.
- `@reconsumet/db`'s real-Postgres test (`postgres.live.test.ts`, via SSH tunnel): **3/3** (two-session lock,
  concurrent migrate from two pools, two runners competing for one job).
- Catalog search on real Postgres, 41.5k rows (incl. tunnel latency): 31–100 ms. `atack on titan` (typo) still finds
  Shingeki no Kyojin.
- **Cleanup:** `docker compose down -v --rmi local` (containers, volume, network, both built images), removed the
  `postgres:17-bookworm` image I had pulled (13:40 UTC; Coolify's own `postgres:15-alpine` untouched), deleted
  `~/reconsumet-e2e` and the upload tarball; ports free again. **Left:** 1.2 GB of Docker build cache (all of it
  unused). A global `docker builder prune` could also drop other projects' cache, so it's your call:
  `docker builder prune` (no sudo needed, you're in the docker group).

### Relay throughput / CPU on the Xeon E5620

Load test from the PC: N parallel "viewers" pulling real Re:Anime 1080p segments through the relay, limits raised.
Measured with the relay container's cgroup CPU counter vs. its own `relay_bytes_out_total`:

| Viewers | Relayed | CPU | CPU per MB | ≈ per 10 Mbit/s |
|---|---|---|---|---|
| 2 | 183.7 MB in ~26 s (~57 Mbit/s) | 6.50 s | 0.035 s | 4.4 % of one core |
| 12 | 205.4 MB in ~29 s (~57 Mbit/s) | 7.74 s | 0.038 s | 4.7 % of one core |

- Throughput was capped by the source CDN (~57 Mbit/s whatever the viewer count), not by the relay. Idle CPU: 0 %.
- At tsss-server's 37 Mbit/s upload the relay would use ~17 % of one of 16 cores. **One Node process could push
  ~200 Mbit/s on this CPU**, so on a VPS bandwidth will run out long before the CPU does.
- **Viewers:** Re:Anime 1080p measured at **6.49 Mbit/s** average (first 2 minutes of Frieren 1), AniZone 1080p
  declares 3.48 Mbit/s (720p 2.38). With `RELAY_GLOBAL_MBPS=32`: **~4–5 Re:Anime 1080p, ~9 AniZone 1080p**, ~13 at
  AniZone 720p.
- (My load script first under-reported its own MB, because parallel workers raced on `bytes += await …`. The relay's
  counter was verified exactly against a single 2,785,984-byte segment. All numbers above use the relay's counter.)

**Would a small segment cache help?** Not with the current bottleneck. A cache saves *download* from the source, but
the limit is our *upload*. Every viewer still has to be sent every byte. It would only help when many viewers watch
the same episode within minutes of each other, or when a source CDN rate-limits us. Not worth it at 5–10 viewers.

## Choices and pushback (ponytail ultra)

- **One `cache` table** (namespaced) holds both the AniList cache and the short-lived stream/episode cache, instead of
  two tables with the same shape.
- **Headers travel inside the token** (2 short headers for FlixCloud, none for AniZone) instead of a header-profile
  table, so the relay needs no source knowledge at all.
- **Viewer binding** is supported (`viewerIp`) but **off by default**: phones changing IP mid-episode would break.
- **Rate limits are per process** (in memory). That's fine for one API instance; it needs a shared store if you run more
  (marked `shortcut:` in the code).
- **Migrations run on API start** under an advisory lock (plus a one-shot `migrate` command).
- **No segment cache** (task rule; see above).

## Left undone / known limits

- **Not deployed** (by design). `docs/deploy.md` has the steps. Two things in it you need to decide: forwarding
  **port 80** as well as 443 (Let's Encrypt's default HTTP challenge in Coolify needs it, or switch Traefik to a
  Cloudflare DNS challenge), and a DDNS updater if your home IP changes.
- **Behind the Cloudflare Tunnel**, Traefik may replace `X-Forwarded-For` with cloudflared's address, so per-IP limits
  on the API would all land on one IP. It matters little (the site calls with a key → per-key limit), but it's not
  verified. The relay (DNS-only → Traefik) shouldn't have this problem. Set `TRUSTED_PROXIES` to Coolify's proxy
  subnet, not to all of `10.0.0.0/8` (that's your LAN).
- **HLS subtitle renditions** (`EXT-X-MEDIA TYPE=SUBTITLES` with `.vtt` segments) are relayed as segments. Upstream
  `text/vtt` is passed through, anything else becomes `video/mp2t`. hls.js doesn't care, Safari's native player might.
  Neither current source uses them (soft subs are separate files).
- **MP4 (non-HLS) streams** would hit the 64 MiB segment cap. Neither source returns MP4 today.
- A segment that takes over **120 s** to relay (e.g. 64 MiB under a crowded global cap) is cut off. Real segments are
  0.5–4 MB.
- Re:Anime's master playlist declares a bogus `BANDWIDTH` (0.01 Mbit/s), so players' ABR can't rely on it.
- Search ranking ties break by newest year (same as the file store): `one piece` lists "THE ONE PIECE (2027)" before
  "One Piece".
- Core's **golden-set live test was not re-run**. Matching and AniList were exercised live through the API e2e only.
  The CLI's AniList usage counter moved from `data/anilist-usage.json` into the AniList cache dir (it restarts at 0
  once).
- Commit `1528d0c` also carries Biome formatting-only changes to a few 0.3 core files that weren't lint-clean at HEAD.

## Commits

```
65c2bcc feat(core): sealed relay tokens, pluggable AniList cache and mapping store
1528d0c feat(core): clientIp behind trusted proxies, per-host concurrency default
c4a9405 feat(db): Postgres schema, migrations and stores (catalog, mappings, cache, keys, health, jobs)
7a9049a feat(api): Hono + OpenAPI API with keys, rate limits, sealed relay URLs, jobs; typed client
15054da feat(relay): sealed-token video/subtitle relay with HLS rewriting, CORS, stream and bandwidth limits, metrics
befd4cc test(api): live end to end through the relay for every source and server
c4d3c9b fix(relay): count and log upstream failures mid-body; 64 KiB throttle chunks
0705c02 chore(docker): api + relay images (bookworm-slim), compose stack with Postgres 17, .env.example
dceb659 docs: api, relay and deploy guides; README status v0.4.0
(this report) docs: task 04 report
(last)        chore(release): 0.4.0   + tag v0.4.0
```

## Push

```sh
cd C:/Users/thesupersupersigma/Desktop/project5/animeSite/RECONSUMET.TS
git push origin master
git push origin v0.4.0
```

(Only RECONSUMET.TS changed. rustyTLS / rustyTLS-js / the site repo untouched.)

## Suggested `brainstorm.md` edits

- **1.13:** "Built in 0.4: AES-256-GCM sealed tokens (not just signed), current + previous secret for rotation; the
  relay rewrites every playlist URI into child tokens (6 h), so the browser never sees a source URL, incl. HD-1's."
- **1.21 / 1.26:** "Measured in 0.4 on tsss-server: relay ≈ 4.5 % of one Xeon core per 10 Mbit/s (CPU not a limit);
  Re:Anime 1080p ≈ 6.5 Mbit/s, AniZone 1080p ≈ 3.5 Mbit/s → with the 32 Mbit/s relay cap ≈ 4–5 Re:Anime or ≈ 9
  AniZone 1080p viewers. Deploy needs port 443 **and 80** forwarded (Let's Encrypt HTTP challenge) and DDNS if the
  home IP changes."
- **1.24 (storage):** "Done in 0.4: catalog, mappings, overrides, AniList cache in RECONSUMET.TS's own Postgres
  (Drizzle, pg_trgm search); file stores kept for the CLI."
- **1.6:** "`@reconsumet/client` = Hono `hc<AppType>` + zod schemas, built from the API's own code."
- **2.5:** mark superseded by 1.21's update (every segment relayed).
- **4.16:** still open (which VPS). Add: "segment cache: not useful while upload is the limit."
- **Change log:** "2026-11-24 (0.4 done): task 04 released v0.4.0 — API + relay + Postgres + Docker; live end to end
  through the relay for both sources on tsss-server; relay throughput/CPU measured."

## What's next (0.5: site base)

The site repo (`thesupersuperanime.lol` v2): Next.js + Prisma + its own Postgres database, Discord login, calling the
API through `@reconsumet/client` with a server-side key, and a player (hls.js) pointed at the relay URLs, with the
relay's `RELAY_ALLOWED_ORIGINS` set to the site's origin. Before that: deploy 0.4 per `docs/deploy.md`.
