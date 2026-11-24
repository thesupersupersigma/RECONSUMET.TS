# Sources, extractors and matching (`@reconsumet/core`)

**In plain English:** a *source* is a streaming site we read from. Give RECONSUMΣT.TS an AniList ID and an episode
number, and it works out which show on each site that is (including when a site splits or numbers seasons
differently from AniList), then returns the video playlist URLs, the headers they need, and the subtitle files.
Video hosts that several sites share (like FlixCloud) live in their own *extractor* files. Two sources exist so far:
**Re:Anime** and **AniZone**. Each has a `README.md` with what we found on the site, including whether a browser
could play its videos directly.

```sh
pnpm reconsumet search anizone "spy x family"
pnpm reconsumet match 142838                    # which show + episode offset on every source
pnpm reconsumet streams 100784 1 --source anizone
pnpm reconsumet streams 145064 5 --dub --json
pnpm reconsumet health
```

## Layout

```
packages/core/src/
├── sources/
│   ├── types.ts       Source interface
│   ├── registry.ts    SOURCES (preference order), createSources(), allHostRules()
│   ├── health.ts      checkHealth(): one GET through the response classifier
│   ├── reanime/       index.ts, README.md (recon), __fixtures__/
│   └── anizone/
├── extractors/        flixcloud.ts (+ __fixtures__/)
└── match/             title.ts, matcher.ts, index.ts (cache + overrides), __fixtures__/golden*.json
```

## The `Source` interface

```ts
interface Source {
  id: string; name: string; baseUrl: string
  search(query): Promise<{ id, title, altTitles[], type?, year?, episodes?, anilistId? }[]>
  getShow(id): Promise<{ id, title, episodes: { number, title?, id, sub?, dub? }[], anilistId? }>
  episodeId(showId, episode): string                     // no request
  getStreams(episodeId, { audio: 'sub' | 'dub' }): Promise<{ servers: {
    name,
    streams: { url, type: 'hls' | 'mp4', quality, headers, audioLang?, playlistKey?, ipLocked? }[],
    subtitles: { lang, label, url, format: 'vtt' | 'ass' | 'srt', default }[],
    intro?, outro?                                         // seconds
  }[] }>
  health(): Promise<{ ok, status, class, ms, error? }>
}
interface SourceDefinition { id, name, hostRules: HostRule[], create(fetcher): Source }
```

- `headers` = what every playlist/key/segment request for that stream must carry (the 0.4 proxy adds them).
- `audioLang` = which audio track of a multi-audio master is sub (Japanese) or dub (English).
- `playlistKey` = the playlists are obfuscated; the proxy decodes them with `decodePlaylist()` (FlixCloud).
- `ipLocked` = the URL is signed for the IP that resolved it.
- `anilistId` on a search result = the site itself says which AniList entry it is: the matcher trusts that over titles.

## Matching (AniList ID → source show + episode offset)

`createMatcher({ media, catalog, dir }).match(anilistId, source)` →
`{ sourceId, showId | null, confidence, episodeOffset, episodeRange?, reasons[] }`.

1. **Queries**, broad first: the romaji title without season/part/format markers, its part before a colon
   ("Gintama.: Porori-hen" → "Gintama."), an AniDB-style "(year)" synonym from the catalog, then the full romaji
   and English titles. At most 4 searches; it stops early on a sure match.
2. **Tier 1: titles.** Normalized (case, accents, punctuation) with "Season 2", "2nd Season", "S2", "Part 2",
   "Cour 2" and "(2023)" pulled out as structure. Similarity = character-bigram Dice, or 0.8 when one title's words
   are a subset of the other's. A verbatim shared title (AniList + catalog synonyms vs. the site's titles) counts as exact.
3. **Tier 2: verification.** Movie vs. series, a year 2+ apart, or a contradicting season or part number rejects
   the candidate. Same year and same episode count add confidence; a different format or episode count costs.
4. **Split cours / continuing numbering.** When a site's show is longer than the AniList entry, the matcher walks
   AniList's PREQUEL/SEQUEL chain: if the show = [prequels…, this entry, sequels…] with matching start year and episode
   sum, the offset is the prequels' episodes. Example: AniZone "Gintama. (2017)" (25 episodes) = AniList Porori-hen (13)
   + Shirogane no Tamashii-hen (12), so Shirogane episode 1 = AniZone episode 14.
5. Best candidate below **0.65** → `showId: null` ("no match"). Never a guess.
6. Results are cached in `<data dir>/mappings.json` (7 days; "no match" 1 day). **Manual fixes** go in
   `<data dir>/overrides.json`:

```json
{ "anizone:100784": { "showId": "tmbhlhbz", "episodeOffset": 13, "note": "AniDB merges Porori + Shirogane" },
  "anizone:136":    { "showId": null, "note": "only the 2011 remake is on AniZone" } }
```

**Golden set:** `src/match/__fixtures__/golden.json` holds 31 tricky AniList IDs with the right answer per source,
checked by hand. `pnpm test` replays a recording of the real searches (`golden-recorded.json`);
`RECORD=1 pnpm test:live` runs it against the live sites and re-records.

## Adding a source: the checklist (what 0.3 did for both)

1. **Find the current domain** in `out/source-index/sources.json` (`tools/source-index`) and on everythingmoe; note
   mirrors and redirects.
2. **Recon before code.** Open the site's search, show and episode pages; find where the data really lives
   (a JSON API, embedded JSON, a player config) and how long lists paginate. Write `sources/<name>/README.md`: domains,
   endpoints, servers, soft vs. hard subs, protections.
3. **Measure the tier** of each request type: plain first, impersonate only where plain is blocked. Write it in the README.
4. **Run the direct-playback probe** on a master playlist, a variant playlist, the key, a segment and a subtitle of
   every video host:
   `node tools/playback-check/probe.ts <url> --referer https://<site>/`. Record status and
   `Access-Control-Allow-Origin` for "bare" / "ours" / "source" in the README. Direct playback needs: 200 for "ours"
   on the plain tier and a CORS header that allows our origin.
5. **Implement** `sources/<name>/index.ts` exporting a `SourceDefinition` (host rules: ≤ 1 request/s per host to
   start). Shared video hosts go in `extractors/<host>.ts`. Pure parse functions, separate from the requests, so
   they're testable.
6. **Record fixtures**: real responses, cut down to what the parser needs. Scrub cookies, CSRF tokens, IPs, signed
   or IP-bound URLs (re-encrypt a fake URL if the real one is ciphertext, as the FlixCloud fixture does).
   `grep` the fixtures for IPs and tokens before committing.
7. **Tests**: offline parser + `getShow`/`getStreams` tests through `fakeFetcher` (`test/helpers.ts`); one live test.
8. **Register** it in `sources/registry.ts`, add it to `GOLDEN_SOURCES` (`test/golden.ts`), fill in its expected
   answers in `golden.json`, run `RECORD=1 pnpm test:live`, and check precision.
