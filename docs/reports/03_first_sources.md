# Report — task 03: catalog, AniList client, first two sources, matching (→ v0.3.0)

Date: 2026-11-24. Author: thesupersupersigma (work done by Claude Code). Committed as I went; nothing pushed.
All tests and measurements ran on the **Windows PC** (home connection, the same public IP as tsss-server).

## Plain-English summary

- **It works end to end.** `reconsumet streams <anilistId> <episode>` returns playable HLS playlists, the headers they
  need and soft subtitles from **Re:Anime** and **AniZone**, sub or dub. Real output for both is below.
- **Matching is right on all 31 hand-checked hard cases** on both sites: split cours ("Part 2"), seasons that sites
  name "(2023)", remakes with the same name, movies vs. TV versions, a 1,184-episode show, a season the site doesn't
  have (correctly "no match"), and a real offset case (AniZone numbers Gintama's Silver Soul arc 14–25 inside one
  show). Caveat: I fixed three matcher bugs *using* this set, so 100 % is a tuning score, not a blind test.
- **Re:Anime needs no guessing at all:** its API is keyed by AniList IDs. Matching only really matters for AniZone.
- **The bad news is about video delivery:** neither site's video can be played by a browser straight from their
  servers. Re:Anime's segments demand their own Referer, and AniZone's servers only allow `anizone.to` in CORS. So
  **every segment of both sources has to go through a relay.** Brainstorm 2.5's plan (segments direct from the CDN)
  doesn't fit these two, and the relay-location decision (home box vs. VPS) is now urgent for 0.4.
- **No TLS impersonation needed anywhere** in 0.3. Plain requests work for every site, API, playlist, segment and
  subtitle. Both of v1's "gated" video hosts have dropped their fingerprint checks.
- **One privacy catch:** Re:Anime's "HD-1" server hands out URLs with a signed token that contains **the IP address
  that asked for it**. If 0.4 ever passed that URL to a browser, viewers could read tsss-server's (= your home) IP. The
  code lists the safer HD-2 first and flags HD-1 as `ipLocked`.

## What works end to end (real output, 2026-11-24, URLs shortened)

```
$ pnpm reconsumet streams 154587 1 --source reanime          # Frieren ep 1
reanime: Sousou no Frieren — source episode 1 (154587/1), sub
  HD-2 (FlixCloud)  intro 0-90s
    hls auto https://fetch8.flixcloud.cc/_v8/bm91gA…NlP/master.m3u8  audio=jpn xor-playlists
      headers {"referer":"https://flixcloud.cc/","origin":"https://flixcloud.cc"}
    subtitles: 3 (en/ass, en/srt)
      default: English (Full Subtitles [9volt]) https://fetch1.subtites4you.com/subtitles/60aa…/60aa…_eng_3.ass
  HD-1 (FlixCloud)  intro 0-90s
    hls auto https://fetch9.flixcloud.cc/_v7/60aa…/master.m3u8?token=<jwt>  audio=jpn xor-playlists ip-locked
    …

$ pnpm reconsumet streams 100784 1 --source anizone          # Gintama. Silver Soul arc ep 1
anizone: Gintama. (2017) — source episode 14 (tmbhlhbz/14), sub
  AniZone
    hls auto https://suzaku.xin-cdn.xyz/300b…/master.m3u8  audio=ja
    subtitles: 3 (pt/ass, es/ass, en/ass)
      default: English https://suzaku.xin-cdn.xyz/300b…/subtitles/2_en.ass

$ pnpm reconsumet streams 145064 5 --dub                     # JJK S2 ep 5, English dub, first source that has it
reanime: Jujutsu Kaisen 2nd Season — source episode 5 (145064/5), dub
  HD-2 (FlixCloud)  intro 0-89s
    hls auto https://fetch8.flixcloud.cc/_v8/Kyt8…FDPz/master.m3u8  audio=eng xor-playlists
    subtitles: 4 (en/ass, en/srt)
```

Also run: AniZone Bleach ep 100 (all 366 episodes listed through Livewire paging),
Frieren S2 ep 3 dub on Re:Anime (17 subtitle languages), and `match` for all 31 golden IDs.

## Golden set: precision per source

31 AniList IDs (`packages/core/src/match/__fixtures__/golden.json`), answers checked by hand on the sites: for
AniZone from its listings (title, year, episode count) and, for the offset cases, episode titles (AniZone "Gintama.
(2017)" ep 14 = Re:Anime/MAL's Silver Soul ep 1; AniZone "Shingeki no Kyojin OAD" eps 1–3 = AniList's 3-episode OVA).

| source | correct | precision | misses |
|---|---|---|---|
| Re:Anime | 31 / 31 | 100 % | none |
| AniZone | 31 / 31 | 100 % | none (2 correct "no match": HxH 1999, My Hero Academia S4) |

Same result offline (`pnpm test`, replaying the recorded searches) and live (`pnpm test:live`).
**Misses found and fixed during the task** (honest version of the 100 %):
1. *Dr. Stone: New World Part 2* mapped to Part 1: both AniZone entries are 2023 with 11 episodes, and both titles
   appear in the AniList synonyms. Fix: on a tie, the longer shared exact title wins ("Dr. Stone: New World (2023)").
2. *Attack on Titan OVA* found nothing: the search kept the word "OVA". Fix: broad queries drop format words.
3. *One Piece* scored low: I used the catalog's July episode count (1168) for an airing show. Fix: only trust catalog
   episode counts for finished shows.

The set covers: multi-season (Frieren, JJK, AoT), split-cour Part 2s (AoT S3P2 + FS P2, Spy×Family P2, Re:Zero S2P2,
Mushoku P2, Slime S2P2, Dr. Stone NW P2), a site that merges cours and continues numbering (Gintama Porori-hen +
Shirogane), movies (JJK 0, Mugen Train) next to same-name TV versions, an OVA, same-name remakes (FMA 2003/2009,
HxH 1999/2011), very long series (One Piece, Bleach), and something airing right now (Marronnier Oukoku no Shichinin no
Kishi, 12 of 20 out).

## Direct playback: can a browser on our site load the video straight from the source?

Probe: `node tools/playback-check/probe.ts <url> --referer <source>`. It tries each URL with no headers ("bare"), with
what a browser on `thesupersuperanime.lol` sends ("ours"), and with the source's own Referer, on plain and impersonate.

| video host (source) | playlists | key | segments | subtitles | CORS | needs headers | needs fingerprint |
|---|---|---|---|---|---|---|---|
| `fetchN.flixcloud.cc` (Re:Anime, HD-1/HD-2) | 200 everywhere, **XOR-obfuscated** | 200 | — | — | `*` | no | no |
| `vault-NN.vertexcdn.site` / `.rundowncdn.top` (Re:Anime segments) | — | — | **403** without FlixCloud's Referer/Origin | — | `*` | **yes** | no |
| `fetchN.subtites4you.com` (Re:Anime subtitles) | — | — | — | 200 | `*` | no | no |
| `*.vid-cdn.xyz` / `*.xin-cdn.xyz` (AniZone) | 200 | 200 | 200 | 200 | **`https://anizone.to` only** | no | no |
| HD-1 master URL (Re:Anime) | signed for the resolving IP (JWT `client_ip`) | | | | | relay on the same IP | |

**What it means for the relay:**
- **Segments of both sources must be relayed.** For Re:Anime because a browser can't send FlixCloud's Referer; for
  AniZone only to add our CORS header (the relay needs no special request headers). Native Safari HLS could play
  AniZone directly, but that's not a basis for the site.
- **Playlists go through our proxy anyway:** Re:Anime's are XOR-obfuscated (we must decode them), and AniZone's
  CORS blocks them. Subtitles: Re:Anime's could load directly (`*`); AniZone's need the proxy.
- So with only these two sources, "segments direct from the CDN" (brainstorm 2.5) saves nothing; every viewer's video
  flows through the relay. At tsss-server's 37 Mbit/s upload that's ~6–9 viewers, and through the Cloudflare Tunnel it
  hits the video rule (brainstorm 0.1). The relay should be a **cheap high-bandwidth VPS** (or a DNS-only subdomain if
  exposing the home IP is accepted). HD-1 can only work through a relay that also does the resolving (same IP).

## Which requests needed `impersonate`

**None.** Measured per request type with the probe and the CLI: reanime.cz API, flixcloud.cc embed + token API, all
FlixCloud playlists/keys/segments, subtites4you.com, anizone.to pages + Livewire, vid-cdn.xyz and xin-cdn.xyz playlists,
keys, segments and subtitles: identical status on `plain` and `impersonate`. v1's gates are gone: `overcdn.site`
doesn't resolve (segments moved to vertexcdn.site / rundowncdn.top), `vid-cdn.xyz` no longer resets plain handshakes,
`xin-cdn.xyz` no longer 403s. Host rules therefore set only rate limits (1 request/s per site, AniList 1 per 2 s).

## What was built

- **Catalog** (`catalog/`): offline-database import (41,537 entries, 20,687 with an AniList ID; 10 s; ETag skip on
  re-run), `CatalogStore` interface + `FileCatalogStore`. Docs: [catalog.md](../catalog.md), with the ODbL/DbCL
  attribution (also in the README).
- **AniList client** (`anilist/`): media / search / small sync, disk cache, daily cap (300), rate-limit headers.
  Requests used today across all work: 90 of 300.
- **Sources** (`sources/`, `extractors/flixcloud.ts`): Re:Anime (FlixCloud crypto, v1's scheme still valid) and
  AniZone (rewritten: data now comes from embedded JSON, paging through Livewire). Recon in each `README.md`.
- **Matching** (`match/`): two-tier ranking/verification, prequel/sequel-run offsets, mapping cache, `overrides.json`.
- **CLI** `reconsumet`: `catalog update|search`, `anilist sync`, `search`, `match`, `streams`, `health`.
  `pnpm reconsumet …` in the repo; `bin` in the package for later.
- **Tool** `tools/playback-check/probe.ts` for the direct-playback test.

## Test results (all run on the Windows PC)

- `pnpm test`: **156 passed** (8 files): catalog, AniList client, both sources' parsers and `getShow`/`getStreams` on
  scrubbed fixtures, FlixCloud decryption, Livewire paging, matcher units, 63 golden-set tests (31 × 2 replays + the precision report).
- `pnpm test:live`: **6 passed** (3 files): TLS reference check (task 02), both sources live end to end (FlixCloud
  master decrypted and decoded to `#EXTM3U`), golden set live 31/31 + 31/31.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: clean.
- Not run on tsss-server: it has Node 20 and this code needs Node 26 (type stripping). Same public IP as the PC,
  so the site measurements should be the same there.

**Fixtures:** cut down to what each parser needs and scrubbed: AniZone's CSRF token replaced, no cookies, no
Cloudflare tokens. The FlixCloud token fixture holds an encryption of a **fake** playlist URL under the real key, so
no real (possibly IP-bound) URL is committed. A grep for IPs, JWTs and session cookies over all fixtures comes back
clean. The golden recording is 316 KB of minified real search results + AniList data.

**One slip to report:** while editing the README with a shell one-liner, backticks in my string ran as commands. That
executed `reconsumet catalog update` (skipped, unchanged), `reconsumet anilist sync` (4 extra AniList requests) and
`reconsumet streams 154587 1`. Nothing was written or broken; I redid the edit with the editor.

## Scope notes (what I'd question)

- **Matching for Re:Anime is unnecessary.** It's keyed by AniList ID; the matcher just takes the site's word
  (`anilistId` on search results). Kept through the same interface so both sources look alike.
- **The golden set is also the tuning set.** A blind check would need fresh IDs nobody tuned on. Cheap to add later.
- **AniZone dub detection costs one extra request** (fetching the master to look for an English audio track).
  Fine for the CLI; the API could cache it.
- **Not built (not asked, or for later):** mirror fallback (reanime.bz/.wtf work if .cz dies; one constant to change),
  hard-sub detection on old AniZone releases, AniZone chapter (intro/outro) parsing from `chapters.vtt`, Postgres.

## Git

Repo: RECONSUMET.TS, branch `master` (rustyTLS and rustyTLS-js untouched in this task).

| commit | message |
|---|---|
| `5259953` | feat(catalog): import the anime offline database into a file-backed CatalogStore |
| `030df7b` | feat(anilist): GraphQL client with cache, daily cap, rate-limit headers and the small sync |
| `f9cb057` | feat(sources): Re:Anime (FlixCloud extractor) and AniZone, plus a direct-playback probe |
| `7d7cffb` | feat(match): AniList to source matching with split-cour offsets, mapping cache, overrides and a golden set |
| `2477033` | docs: catalog and sources docs, README status and ODbL attribution; export the new modules |
| (next) | docs: task 03 report |
| (last) | chore(release): 0.3.0, tagged `v0.3.0` |

Push (you run this):

```sh
cd RECONSUMET.TS   # from animeSite/
git push origin master
git push origin v0.3.0
```

## Suggested edits to `brainstorm.md` (not applied)

- **0.1, new fact (2026-11-24):** "Re:Anime: API keyed by AniList IDs; FlixCloud crypto unchanged since v1; segments
  moved to `vertexcdn.site` / `rundowncdn.top` and need FlixCloud's Referer; HD-1 URLs carry a JWT with the resolver's
  IP. AniZone: data in embedded JSON, episode paging via Livewire; its CDNs (`vid-cdn.xyz`, `xin-cdn.xyz`) no longer
  fingerprint-gate but allow only `anizone.to` in CORS. No request in 0.3 needs TLS impersonation."
- **0.1, update the v1-gated-hosts line:** "vid-cdn.xyz and xin-cdn.xyz now answer plain requests; overcdn.site is
  replaced by vertexcdn.site / rundowncdn.top (Referer-gated, not fingerprint-gated)."
- **1.21 / 2.5 / 4.11:** "Measured in 0.3: both first sources need every segment relayed (Referer resp. CORS). Direct
  CDN playback saves nothing for them, so the relay carries all video. Pick the relay location before 0.4's proxy:
  Claude recommends a cheap high-bandwidth VPS (37 Mbit/s upload ≈ 6–9 viewers; Cloudflare's video rule)."
- **1.13, add:** "Never hand a source URL that embeds our IP (FlixCloud HD-1 JWT) to the browser; the proxy resolves
  and relays it itself."
- **1.24, add:** "Built in 0.3: offline DB import (41.5k entries, ETag skip), AniList small sync = 4 requests/day,
  daily cap 300."
- **1.25, add:** "AniZone names entries like AniDB ('Spy x Family (2022)'); the offline DB's synonyms carry those
  titles, which is what makes AniZone matching reliable."

## What's next — 0.4

- **Hono API** over the library: `/search`, `/anime/:anilistId`, `/streams/:anilistId/:episode`, typed client for the
  site (brainstorm 1.6, 1.20).
- **Signed proxy** (1.13): short-lived signed links; playlist rewriting incl. FlixCloud XOR decoding (`playlistKey`),
  per-stream headers (`headers`), AES key passthrough, subtitle CORS. Segment relay for both sources, so decide the
  relay location first (see above). Use `fetcher.request(url, { untrusted: true })` for every playlist-derived URL.
- **Postgres**: `CatalogStore`, mappings and overrides as tables; the AniList cache can stay on disk.
- Scheduling: weekly `catalog update`, daily `anilist sync`.
