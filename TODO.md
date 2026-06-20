# TODO — harden the self-hosted anime API

Working plan for turning this fork into a reliable standalone API. Items are ordered
**highest-leverage first**. The season-disambiguation fix is the only item that addresses
the actual reported bug ("season 2 plays season 1"); everything else is hardening.

**Conventions for every item below**
- After each change, `cd consumet && npm run build` (i.e. `npx tsc -p tsconfig.json`) and
  confirm it compiles before moving on. Pre-existing strictness warnings (`rabbit.ts`
  TS2322, `anilist.ts` TS2872/2881) are NOT ours and don't block the build — only `TS2307`
  (module-not-found) matters.
- One focused commit per item, short single-line message.
- **Do not touch `.env` files.** Keep the diff reviewable — no refactors beyond these items.

---

## ⚠️ Correction to the original brief (already agreed)
The brief said to pull AniList `season` and match it as the show's season number. **Wrong.**
AniList `season` = the *airing* season (`WINTER`/`SPRING`/`SUMMER`/`FALL`), and `seasonYear`
is the air year — neither is the sequel ordinal (S1/S2/S3). AniList has **no** "this is
season 2" field. The real S1-vs-S2 signal must come from **parsing ordinal tokens out of the
title/synonyms** (and out of provider slugs), with **year** + **format** as secondary
filters. The plan below reflects this.

---

## 1. ROOT-CAUSE: season disambiguation — TWO-TIER (recall → verify)  ← do this first, alone
**File:** `consumet/src/providers/meta/aggregator.ts` (+ a one-line surface in `reanime.ts`)

**Why:** `bestMatch` (`:97-108`) maps an AniList id → provider slug by **pure title
similarity** (`compareTwoStrings`, keep highest ≥ 0.5). Multi-season shows have near-identical
titles, so an S2 AniList id can resolve to S1's slug. Verified: zero season/year/format/id
awareness today. The site-side `PROVIDER_PRIORITY` flip only patched the symptom.

**Reframe: title is for *recall*, metadata is for *precision*.** Today title does both, so
precision fails on collisions. Fix = generate candidates cheaply by title, then **verify the
winner against metadata** — and on no-match, **fail loudly and fall through** to the next
provider instead of confidently serving S1.

### Code reality this design is built on (verified, not assumed)
- **ReAnime is keyed by AniList id.** `reanime.ts:42-44,118,130`: episode ids are
  `"<anilistId>/<ep>"`, the watch payload exposes `anime.anilist`, `anilistIdFrom` reads the
  `bx<id>` cover URL. → an **exact** bridge, currently unused.
- **`totalEpisodes` is available on every provider** (`= episodes.length`) → episode-count
  verification is feasible. But weak alone: same-count seasons (Re:Zero S1=25/S2=25) and
  ongoing simulcasts (AniList count ≠ released count) defeat it. Backstop, not a key.
- **Content air-year is NOT exposed** by anineko/anikototv/reanime (only `animenosub.ts:147`
  has a per-episode `.epl-date`). So "year" comes from the **slug**, and slugs carry the
  **ordinal** (`...-season-4`, `anineko.ts:101`), not a year. The ordinal token is the real
  discriminator these providers give us.
- **`Gogoanime.fetchAnimeInfo` spins up a cloakbrowser render** (CLAUDE.md). `getMappings` is
  called by `/info` for *all* providers → we must **not** eagerly fetch episode lists for
  runner-up candidates during mapping. Verification has to be cost-aware.

---
### TIER 1 — cheap candidate ranking (in `getMappings`/`bestMatch`, NO episode fetches)

**1a. Direct-ID bridge first.** Add a tiny per-provider capability: if a provider can resolve
its own AniList id (ReAnime; any provider whose cover is `anilistcdn/.../bx<id>`), prefer/verify
by exact id over title. For ReAnime: surface the resolved AniList id from `fetchAnimeInfo`
(it already reads `anime.anilist`) so Tier 2 can do an exact `=== requestedId` check. This
turns ReAnime from a fuzzy match into an exact bridge.

**1b. Enrich the AniList lookup** — `titlesFor` → `metaFor` returning a meta object:
```graphql
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    title { romaji english native }
    synonyms
    format          # TV, TV_SHORT, MOVIE, OVA, ONA, SPECIAL
    episodes        # for Tier-2 count verification
    seasonYear
    startDate { year }
  }
}
```
```ts
interface AniMeta {
  titles: string[];        // english, romaji, native, ...synonyms (filtered) — match ALL, native differs most
  episodes?: number;       // for Tier-2 count check
  year?: number;           // seasonYear ?? startDate.year
  format?: string;         // light MOVIE/OVA guard
  seasonNumber?: number;   // ORDINAL parsed from titles/synonyms; undefined if no marker
}
```
> Do **not** request `season` for the ordinal — it's the weather season. Year only ever comes
> from `seasonYear`/`startDate.year` (AniList side) or the slug (provider side).

**1c. Two pure helpers** (unit-testable, no network):
```ts
detectSeasonNumber(text): number | undefined
//   "season 2" | "season-2" | "2nd/3rd/4th season" | "part 2" | "cour 2"
//   | "second/third season" | Japanese "2期"/"第2期" | trailing roman "... II"/"III".
//   Returns undefined with no marker ("Ultra Romantic", plain S1). Does NOT trust a bare
//   slug "s2"/number unless tied to a season token (avoids "86", "Steins;Gate 0", "Mob Psycho 100").
detectYear(text): number | undefined   // require (19|20)\d\d to avoid matching name-numbers
```

**1d. Rank + keep TOP-N candidates** (N=3) per provider — not just the single best. Gate on the
**base** title score (≥ 0.5) so metadata can never rescue a garbage title; among those, sort by:
```
adjusted = baseTitleScore
  + (aniSeason!=null && resSeason!=null && aniSeason===resSeason ?  SEASON_BONUS : 0)
  - (aniSeason!=null && resSeason!=null && aniSeason!==resSeason ?  SEASON_PENALTY : 0)
  + (aniYear!=null   && resYear!=null   && aniYear===resYear     ?  YEAR_BONUS   : 0)
  - (aniYear!=null   && resYear!=null   && aniYear!==resYear     ?  YEAR_PENALTY : 0)
  - (AniList==TV but slug/title literally says "movie"/"ova"      ?  MISMATCH_PENALTY : 0)
```
`resSeason`/`resYear` from **both** result title and slug (`r.id`), max found. Start:
`SEASON_BONUS 0.15`, `SEASON_PENALTY 0.30`, `YEAR_BONUS 0.10`, `YEAR_PENALTY 0.15`,
`MISMATCH_PENALTY 0.40` (all tunable consts). `getMappings` returns the **best** per provider
for `/info` (output shape unchanged, stays cheap); the **ranked candidate list** is threaded to
Tier 2. When both ordinals are `undefined` (single-season show) → zero adjustment → behaves
exactly as today (no regression).

---
### TIER 2 — verification where we already pay for the fetch (in `getEpisodes`)

`getEpisodes` already calls `fetchAnimeInfo` to get the episode list — verify there, ~free:

**2a.** For each provider in preference order, walk its Tier-1 candidates:
- **Cost-aware:** cheap HTTP providers (AniNeko, AnimeNoSub, AnikotoTV, ReAnime, AnimeUnity)
  may probe alternate candidates; the **browser-gated Gogoanime verifies only candidate[0]**
  and falls through on mismatch (never fires extra renders).
- Fetch `fetchAnimeInfo(candidate.id)`, then **verify** against `AniMeta`:
  - leaked AniList id available (ReAnime) → require `=== requestedId` (**exact**); else
  - episode-count within tolerance `|info.episodes.length − aniMeta.episodes| ≤ EPISODE_COUNT_TOLERANCE`
    (default ±2), **skipped** when `aniMeta.episodes` is null/ongoing (then trust the Tier-1
    ordinal rather than count).
- First candidate that verifies → return it.

**2b. Fail loudly, fall through.** If no candidate for a provider verifies, move to the next
provider. If **no provider** verifies, return `{ provider: null, episodes: [], reason }` — do
NOT silently return an unverified S1 match. (Surface `reason` so `/episodes` can report it.)

---
### 1e. Verify (acceptance test for the whole bug)
Resolve S1/S2/S3 AniList ids via `agg.search(...)` at test time (don't hardcode ids), then assert
`getEpisodes` returns **different, season-correct** results per season AND that a deliberately
wrong season **falls through** rather than serving S1:
- Kaguya-sama (S1/S2/S3 — ordinal + "Ultra Romantic" named case), **Re:Zero S2** (same count as
  S1 → ordinal must break it, count can't), one **ongoing** show (count unreliable → ordinal path).
- Prefer browser-free providers (AniNeko/AnimeNoSub) so cloakbrowser isn't required. Tune the
  constants here if a real case needs it.

### 1f. Known limitations (report these)
- Re-ranks/verifies only **what the provider's search returns**. If a clone never surfaces the
  S2 entry, nothing can conjure it — but now we **detect** that (no candidate verifies) and fall
  through instead of being confidently wrong.
- Named sequels with no ordinal AND no exposed year/leaked-id stay ambiguous (rare).
- Heuristic + verification, **not** a curated ID map (out of scope; these clones aren't in
  malsync-style DBs anyway).
- **Deferred (not this pass):** relations-graph positional alignment — needs a provider-side
  ordering signal which, with no content-year exposed, reduces to the slug ordinal Tier 1
  already matches; adds real complexity (interleaved movies/OVAs) for little gain here.

**Scope note:** this is consciously bigger than one tiny commit. Land as **two commits** to stay
reviewable:
- `feat(aggregator): rank top-N candidates by ordinal/year/format + direct-id bridge` (Tier 1)
- `fix(aggregator): verify mapped season by id/episode-count, fall through on mismatch` (Tier 2)

---

## 2. Fragile / dead extractors — make failure modes explicit
**Audit result (already checked): neither dead extractor is reachable from a live provider.**
No provider imports `filemoon` or `bilibili`; `animenosub.ts` only references "Filemoon" in a
comment and already throws `Moon … not supported`. Both are only re-exported from
`extractors/index.ts` as library surface. So this item is **hygiene**, not an active-bug fix —
but worth doing so they can't silently fail if wired up later.

- **`consumet/src/extractors/rabbit.ts`** (1245 lines: embedded PNG byte array +
  hand-transcribed WASM loader for rabbitstream/vidcloud — the most fragile file in the repo).
  Add a top-of-file comment: *"rotate-and-replace wholesale when rabbitstream changes its
  bundle — do not attempt surgical debugging."* **Do not rewrite it.**
- **`consumet/src/extractors/filemoon.ts`** — non-functional (builds `newScript`, discards it,
  returns empty `this.sources`). Make `extract` **throw** a clear
  `"Filemoon extractor not implemented"` instead of silently returning `[]`. (Finishing it is
  non-trivial → throw, per option (a) in the brief.)
- **`consumet/src/extractors/bilibili.ts`** — points at the dead `api.consumet.org`. Make
  `extract` **throw** a descriptive `"Bilibili extractor unsupported (api.consumet.org is
  dead)"` so it can't silently no-op in a pipeline.
- Re-confirm after the edits that the active providers (AniNeko, AnimeNoSub, AnikotoTV,
  ReAnime, Gogoanime, AnimePahe, AnimeUnity) still build and don't reach these throwers.

**Commit:** `chore(extractors): mark rabbit fragile; make filemoon/bilibili fail loudly`

---

## 3. API hardening
**File:** `api/src/server.mjs` (+ `api/package.json`)

- **Rebrand the description.** `api/package.json:6` says *"Self-host HTTP API over the anime
  aggregator (rebrand me before going public)"*. Pick a neutral internal name (e.g.
  **"anime aggregator API"** — already `name: "anime-api"`) and update the package description
  + the file-header comment (`server.mjs:1-2` also says "rebrand before going public"). Nothing
  brand-specific.
- **Input validation on every route**, return `400` + clean JSON (not a 500 stack):
  - `/search` — `q` required (already 400s; keep) and non-empty after trim.
  - `/info/:anilistId`, `/episodes/:anilistId` — currently **unvalidated**; reject non-numeric
    ids with `400 { error: "anilistId must be numeric" }`.
  - `/watch` — `provider` + `episodeId` required (already 400s; keep); validate `type` ∈
    {`sub`,`dub`} (default `sub`).
  - `/proxy` — `url` required (already 400s; keep); reject non-`http(s)` targets.
- **Per-IP rate limiter** — in-memory token bucket keyed by IP. Configurable via env
  (e.g. `RATE_LIMIT_PER_MIN`, sane default like 120/min; `0` = disabled). Return `429` with a
  clean JSON body when exceeded. (Use `@fastify/rate-limit` only if already a dep; otherwise a
  tiny hand-rolled bucket to avoid adding deps.)
- **CORS** — `origin: '*'` (`server.mjs:35`) is intentional for an exposed read-only API.
  Leave a one-line comment saying so.
- **Optional API-key gate** — env-driven, **OFF by default** (`API_KEY` unset → no gate), so
  local/dev keeps working. When set, require a header; `/` and health stay open.
- **Root `/` route** — keep as health/info, but it currently leaks VM internals
  (`server.mjs:202-203`: cloakbrowser reachability + TLS-impersonation host list). Gate that
  detail behind a debug flag (e.g. `DEBUG_INFO=1`); default response shows only
  name/status/providers/routes.
- **Port** — defaults to 3000 (`server.mjs:22`), run on 4000 via env in prod. Keep the
  env-driven behavior; add a comment making the default explicit.

**Commit:** `feat(api): input validation, rate limiting, rebrand, gate debug info`

---

## 4. Robustness pass
- **Graceful degradation.** `getMappings`/`getEpisodes` already try/catch per provider.
  Verify `getSources` (`aggregator.ts:155-159`) and the `/watch` + `/info` + `/episodes`
  routes return a **clean error** (4xx/502 JSON), never a raw 500 stack:
  - `/watch` calls `agg.getSources` with no try/catch → a throwing extractor becomes a 500 via
    the global handler. Wrap it: map a known "unknown provider" to 400, upstream failures to
    502, with `{ error }`.
  - Confirm the global `setErrorHandler` (`server.mjs:285-288`) returns only `err.message`,
    not a stack (it does today — keep it).
- **Consistent, configurable timeouts.** Currently hardcoded:
  - `aggregator.ts:43` axios client `timeout: 20000`
  - `server.mjs` proxy fetch `AbortSignal.timeout(30000)` + curl `--max-time 30`; cloak check
    `4000`
  - providers/extractors: `60000`, `25000`, `20000` (enumerate exact locations during impl)
  Introduce env-driven defaults (e.g. `HTTP_TIMEOUT_MS`, `PROXY_TIMEOUT_MS`) with the current
  values as fallbacks, and replace the scattered literals. Keep it minimal — don't thread a new
  config object through everything; module-level constants reading `process.env` are fine.

**Commit:** `chore: graceful source errors + env-configurable timeouts`

---

## Deliverables (report back when done)
1. Per-file summary of what changed.
2. Anything reachable-but-broken found along the way.
3. What's still fragile / to watch when something breaks (rabbit.ts, the heuristic's limits,
   provider search coverage).

## Non-goals (explicitly out of scope this pass)
- No curated AniList→slug mapping DB (the "real" season fix); heuristic + verification only.
- No relations-graph positional alignment (deferred — see 1f).
- No rewrite of `rabbit.ts`; no finishing `filemoon`.
- No `.env` changes. The only provider-file change is surfacing ReAnime's already-read AniList
  id from `fetchAnimeInfo` (1a) so Tier 2 can verify it; no other provider behavior changes.
- No new heavy deps.

## Open questions for your review
- **Rate-limit default**: 120 req/min/IP OK, or different?
- **API-key gate**: include the (off-by-default) scaffold now, or skip until you actually
  expose it?
- **Tier-1/Tier-2 constants** (`N=3` candidates, `EPISODE_COUNT_TOLERANCE=±2`, the bonus/penalty
  set in 1d) are starting values — fine to tune during the 1e verify step if a real case needs it?
- **ReAnime exact-id bridge**: OK to add the one-line change surfacing its resolved AniList id
  from `fetchAnimeInfo` so Tier 2 can do an exact match? (Confirmed it already reads it.)
