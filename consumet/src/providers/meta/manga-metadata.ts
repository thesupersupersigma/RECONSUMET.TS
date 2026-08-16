import { AxiosInstance } from 'axios';

import { safeErrorString } from '../../utils/cf-solver';
import {
  MALSYNC_SITE_BINDINGS,
  MALSYNC_UNMAPPED_SITES,
  PROVIDERS_WITHOUT_MALSYNC_COVERAGE,
  MalSyncIndex,
  MangaAliasResolver,
  MangaDexXref,
  faultForError,
  pickSiteEntry,
  type IMalSyncSiteBinding,
  type IXrefFault,
} from './manga-xref';
import type {
  IMangaIdBridge,
  IMangaMeta,
  IMangaMetadataResolver,
  MangaMatchVia,
} from './manga-aggregator';

// ---------------------------------------------------------------------------------------------
// THE METADATA LAYER — what gets injected into MangaAggregator.
//
// SHAPE OF THE DECISION, which is settled and implemented here rather than re-argued:
//   * AniList `Media(type: MANGA)` is the CANONICAL ID SPACE. `/manga/info/:anilistId` keys off an
//     AniList MANGA id, which is a different number space from AniList's anime ids (One Piece is
//     anime 21 and manga 30013 — verified live, id 30013 returns ONE PIECE with idMal 13).
//   * MangaDex is a VERIFIER, not the metadata source: `attributes.links.al` is a hard external id
//     asserted by MangaDex staff. See ./manga-xref.ts for the evidence and the algorithm.
//   * MAL-Sync is a second ID BRIDGE, reachable for free because AniList hands us `idMal`.
//
// EVERYTHING HERE IS INJECTED THROUGH THE CONSTRUCTOR of MangaAggregator, so this file is purely
// additive: it imports only TYPES from ./manga-aggregator (which erase at compile time, so there
// is no require() edge and therefore no module cycle), and the aggregator reaches it through one
// factory call.
//
// WHY THE RESOLVER IS A DECORATOR AND NOT A REPLACEMENT. B1's `AniListMangaMetadataResolver`
// already speaks AniList correctly, including the `graphqlErrorsSummary` rate-limit detection that
// stops an HTTP-200-with-errors[] from being misread as "no provider had the title". Rewriting
// that would duplicate a subtle behaviour for no gain, and importing it as a VALUE would create
// the module cycle this file is careful to avoid. So it is passed IN and wrapped.
// ---------------------------------------------------------------------------------------------

/**
 * Cap on `IMangaMeta.titles` after enrichment.
 *
 * NOT cosmetic. `MangaAggregator.rankedMatches` scores the full cross product of
 * (our titles) x (provider titles + alt titles) with `compareTwoStrings`, PER RESULT, PER
 * PROVIDER. The MangaDex record for Solo Leveling alone carries 37 alt titles; unbounded, one
 * search turns into tens of thousands of bigram comparisons. 24 keeps every AniList title plus a
 * useful spread of romanisations.
 */
const MAX_TITLES = 24;

// =============================================================================================
// THE FAULT CHANNEL — how a CALLER learns a bridge was skipped rather than answered
//
// WHAT WAS WRONG. ./manga-xref.ts already models "upstream refused" as a first-class value
// (`IXrefResult.fault`), but every consumer in THIS file called the legacy `resolve()` / `lookup()`
// surface, which is literally `(await …Result()).value`. So the typed vocabulary existed and
// nothing consumed it: a caller of `createMangaMetadataLayer` still saw exactly one thing —
// `null` — whether MAL-Sync had said "no such mapping" or had said nothing at all. The cache fix
// from the previous pass was real and unreachable. This is the same shape as the pass before, where
// working alias resolution was dead code because the provider was never registered.
//
// WHY THE FAULT IS OUT OF BAND, AND NOT IN THE RETURN VALUE. `IMangaIdBridge.lookup` returns
// `Promise<string | null>` and `IMangaMetadataResolver.resolve` returns `Promise<IMangaMeta>`; both
// are declared in ./manga-aggregator.ts, which this file imports only TYPES from (that is what
// keeps the module graph acyclic). More importantly the aggregator's contract is deliberately
// pessimistic — a THROWING bridge is caught and the candidate stays 'unverified', so that a bug can
// never manufacture confidence. A transient 429 must land in exactly the same place: the bridge
// still returns null, the provider's title search still runs, and the mapping is still labelled by
// its own weaker evidence. Encoding the fault in the return value could only ever be an invitation
// to promote on it. So the DEGRADED ANSWER IS UNCHANGED and the fault travels beside it.
//
// WHAT THAT BUYS, concretely: `/manga/info` for a series MAL-Sync happens to be throttled for now
// serves the same honest 'unverified' mapping it always did, but the layer can also state WHY the
// strong path did not run — which is the difference between "MangaHere genuinely is not in
// MAL-Sync" (a durable fact, listed in PROVIDERS_WITHOUT_MALSYNC_COVERAGE-adjacent terms) and "we
// could not find out for the next 30 seconds". Four fail-open providers survived to Phase 3 because
// nothing in the system could say that sentence.
// =============================================================================================

/** Where in the layer a fault was hit. `bridge` events additionally carry `provider`. */
export type MangaXrefFaultStage = 'metadata' | 'bridge';

/** One upstream refusal, attributed to the layer component and lookup that hit it. */
export interface IMangaXrefFaultEvent {
  stage: MangaXrefFaultStage;
  /** `'verified-metadata'`, or the bridge's `name` — `'mangadex-links.al'` / `'malsync'`. */
  where: string;
  /** The provider the bridge was asked about. Absent for `stage: 'metadata'`. */
  provider?: string;
  /** The AniList manga id under lookup, so an event can be correlated with a request. */
  anilistId: string;
  /** The typed refusal from ./manga-xref.ts, including any clamped `retryAfterMs`. */
  fault: IXrefFault;
  /** `Date.now()` when the event was raised. */
  at: number;
}

/** Notified for every upstream refusal. MUST NOT throw; the layer guards it anyway. */
export type MangaXrefFaultObserver = (event: IMangaXrefFaultEvent) => void;

/** Events retained by {@link MangaXrefFaultLog}. Bounded so a sustained outage cannot grow memory. */
const FAULT_LOG_MAX = 100;

/**
 * A bounded, pull-based record of upstream refusals, hung off the layer.
 *
 * TWO CHANNELS, DELIBERATELY. A push observer (`options.onXrefFault`) is what a caller wires when it
 * wants to react — emit a metric, tag a response. This log is what a caller reads when it did NOT
 * wire anything in advance, which is the normal case for a diagnostics endpoint and for a test.
 * Requiring pre-registration to observe a fault would reproduce the original problem in a new place.
 *
 * It is NOT a health check and does not decide anything: nothing in this file reads it back.
 */
export class MangaXrefFaultLog {
  private readonly events: IMangaXrefFaultEvent[] = [];
  /** Total ever recorded, including events already evicted from the bounded window. */
  total = 0;

  record = (event: IMangaXrefFaultEvent): void => {
    this.total++;
    this.events.push(event);
    if (this.events.length > FAULT_LOG_MAX) this.events.splice(0, this.events.length - FAULT_LOG_MAX);
  };

  /** The most recent events, oldest first. Defaults to the whole retained window. */
  recent = (limit: number = FAULT_LOG_MAX): IMangaXrefFaultEvent[] =>
    this.events.slice(Math.max(0, this.events.length - Math.max(0, limit)));

  /** Every retained fault for one AniList manga id. The per-request question. */
  forAnilistId = (anilistId: string | number): IMangaXrefFaultEvent[] => {
    const key = String(anilistId);
    return this.events.filter(e => e.anilistId === key);
  };

  /**
   * Counts by `kind` and by `source` over the retained window, plus the longest back-off any
   * upstream asked for. Enough for a diagnostics endpoint to say "MAL-Sync is throttling us" without
   * re-deriving anything.
   */
  summary = () => {
    const byKind: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let maxRetryAfterMs: number | undefined;
    for (const e of this.events) {
      byKind[e.fault.kind] = (byKind[e.fault.kind] ?? 0) + 1;
      bySource[e.fault.source] = (bySource[e.fault.source] ?? 0) + 1;
      if (e.fault.retryAfterMs !== undefined && (maxRetryAfterMs === undefined || e.fault.retryAfterMs > maxRetryAfterMs))
        maxRetryAfterMs = e.fault.retryAfterMs;
    }
    return {
      total: this.total,
      retained: this.events.length,
      byKind,
      bySource,
      ...(maxRetryAfterMs === undefined ? {} : { maxRetryAfterMs }),
    };
  };

  clear = (): void => {
    this.events.length = 0;
    this.total = 0;
  };
}

/**
 * Call an observer without letting it become a new failure mode.
 *
 * A bridge that throws is caught by the aggregator and degrades the candidate to 'unverified' — so
 * an observer throwing would silently DOWNGRADE matches, turning a diagnostics hook into a
 * correctness bug. It is swallowed here instead.
 */
const notifyFault = (observer: MangaXrefFaultObserver | undefined, event: IMangaXrefFaultEvent): void => {
  if (!observer) return;
  try {
    observer(event);
  } catch (err) {
    console.error(`[manga-metadata] an onXrefFault observer threw and was ignored: ${safeErrorString(err)}`);
  }
};

// =============================================================================================
// RESOLVER
// =============================================================================================

export interface IVerifiedMangaMetadataResolverOptions {
  /**
   * Append alt titles from the links.al-VERIFIED MangaDex record. Default true.
   *
   * This cannot introduce a false match: the titles come from the one record MangaDex itself
   * labels with this exact AniList id, so they are by construction titles OF this series. What it
   * buys is reach — the scanlation providers index by romanisation, and AniList's synonym list is
   * often missing the one a given site uses.
   */
  enrichTitles?: boolean;
  /**
   * Adopt `links.mal` from the verified MangaDex record when AniList reports no `idMal`.
   * Default true. This is what makes the MAL-Sync bridge reachable for series AniList has not
   * linked to MAL — without it those series have no bridge at all, because MAL-Sync has no
   * AniList-keyed manga endpoint (verified live: `/anilist/manga/105778` → 404).
   */
  backfillMalId?: boolean;
  /**
   * Notified whenever an upstream on the cross-reference path REFUSED, as opposed to answering
   * "nothing here". Optional; without it the layer's own {@link MangaXrefFaultLog} still records
   * every event, so nothing is lost by not wiring this.
   */
  onXrefFault?: MangaXrefFaultObserver;
}

/**
 * AniList primary, MangaDex as verifier.
 *
 * Delegates to the injected AniList resolver, then — best effort, never fatal — cross-references
 * MangaDex by `links.al` and folds three things back in:
 *   1. alt titles from the verified record (better provider search coverage),
 *   2. `idMal` when AniList has none (unlocks the MAL-Sync bridge),
 *   3. `startYear` when AniList has none (B3's 'metadata' tier reads it).
 *
 * WHAT IT DOES NOT DO, deliberately:
 *   * It does not overwrite anything AniList stated. AniList is canonical; MangaDex only fills
 *     holes. A field present on both and disagreeing is LOGGED, not silently reconciled.
 *   * It does not backfill `countryOfOrigin`. MangaDex's `originalLanguage` is 'ja'/'ko'/'zh' and
 *     AniList's is 'JP'/'KR'/'CN'/'TW' — 'zh' maps to either CN or TW with no way to tell which,
 *     and B3 keys its manga/manhwa/manhua tier off this field. A guess here would be a wrong
 *     answer wearing a verified record's authority.
 *   * It does not synthesise a chapter count. AniList returns `chapters: null` for every RELEASING
 *     series (One Piece, manga 30013 — confirmed null/null), and providers disagree structurally
 *     anyway (split chapters, decimals like 100.5, per-language feeds, "Official Colored"
 *     re-releases as separate series). `AnimeAggregator`'s EPISODE_COUNT_TOLERANCE has no port and
 *     faking one would manufacture confidence exactly where wrong-match risk is highest.
 */
export class VerifiedMangaMetadataResolver implements IMangaMetadataResolver {
  private readonly enrichTitles: boolean;
  private readonly backfillMalId: boolean;
  private readonly onXrefFault?: MangaXrefFaultObserver;

  constructor(
    /** B1's `AniListMangaMetadataResolver`, or any other AniList-speaking resolver. */
    private readonly base: IMangaMetadataResolver,
    private readonly xref: MangaDexXref,
    options: IVerifiedMangaMetadataResolverOptions = {}
  ) {
    this.enrichTitles = options.enrichTitles ?? true;
    this.backfillMalId = options.backfillMalId ?? true;
    this.onXrefFault = options.onXrefFault;
  }

  resolve = async (anilistId: string | number): Promise<IMangaMeta> => {
    let meta: IMangaMeta;
    try {
      meta = await this.base.resolve(anilistId);
    } catch (err) {
      // THE BASE RESOLVER IS NOT AN IXrefResult SURFACE. `AniListMangaMetadataResolver` (in
      // ./manga-aggregator.ts) posts WITHOUT `validateStatus`, so a 429 or 5xx from AniList throws
      // straight through here and out of the whole /manga/info call. That behaviour is unchanged —
      // rethrown below — but it is no longer INVISIBLE: an AniList refusal now shows up in the same
      // fault channel as a MangaDex or MAL-Sync one, which is the difference between diagnosing the
      // outage and re-running a 13-agent investigation.
      notifyFault(this.onXrefFault, {
        stage: 'metadata',
        where: 'anilist-base-resolver',
        anilistId: String(anilistId),
        fault: faultForError(err, 'anilist-metadata'),
        at: Date.now(),
      });
      throw err;
    }

    // No titles means AniList itself failed (its rate limiting is an HTTP 200 with a populated
    // errors[] and null data, which the base resolver already logs as an UPSTREAM fault). Spending
    // MangaDex and MAL-Sync requests on a series we know nothing about would turn one upstream
    // outage into three, and the aggregator is about to skip every provider anyway.
    //
    // KNOWN REMAINING CONFLATION, STATED RATHER THAN PAPERED OVER: an empty `titles` is ALSO what a
    // genuinely unknown AniList id produces, and `AniListMangaMetadataResolver` discards the
    // errors[] it detected (it logs, then returns the same empty shape). So this one branch cannot
    // raise a fault event — the information is destroyed upstream of this file, in
    // ./manga-aggregator.ts, which this item does not own. Fixing it means having that resolver
    // return an IXrefResult-shaped answer or accept an observer of its own.
    if (!Array.isArray(meta.titles) || meta.titles.length === 0) return meta;

    let record;
    try {
      // `resolveResult`, not `resolve`: the fault is the reason this method exists in the pair.
      const result = await this.xref.resolveResult(meta);
      if (result.fault)
        notifyFault(this.onXrefFault, {
          stage: 'metadata',
          where: 'verified-metadata',
          anilistId: meta.anilistId,
          fault: result.fault,
          at: Date.now(),
        });
      record = result.value;
    } catch (err) {
      // MangaDexXref already swallows its own errors; this is belt-and-braces so a metadata
      // resolver can never be the reason a whole /manga/info call fails.
      console.error(
        `[manga-metadata] MangaDex cross-reference threw for AniList manga id ${meta.anilistId} ` +
          `(continuing with AniList-only metadata): ${safeErrorString(err)}`
      );
      notifyFault(this.onXrefFault, {
        stage: 'metadata',
        where: 'verified-metadata',
        anilistId: meta.anilistId,
        fault: faultForError(err, 'mangadex'),
        at: Date.now(),
      });
      return meta;
    }
    if (!record) return meta;

    const enriched: IMangaMeta = { ...meta };

    if (this.enrichTitles) {
      // APPEND, NEVER PREPEND. `rankedMatches` searches providers with `meta.titles[0]`, so
      // AniList's primary title must stay at index 0 — reordering here would silently change what
      // every provider is asked for.
      const seen = new Set(enriched.titles.map(t => t.toLowerCase()));
      const extra: string[] = [];
      for (const t of record.titles) {
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        extra.push(t);
      }
      enriched.titles = [...enriched.titles, ...extra].slice(0, MAX_TITLES);
    }

    if (record.malId !== undefined) {
      if (meta.malId === undefined) {
        if (this.backfillMalId) {
          enriched.malId = record.malId;
          console.warn(
            `[manga-metadata] AniList manga id ${meta.anilistId} has no idMal; adopting ` +
              `links.mal=${record.malId} from the links.al-verified MangaDex record ` +
              `${record.id} (this is what makes the MAL-Sync bridge reachable for this series)`
          );
        }
      } else if (meta.malId !== record.malId) {
        // Both sides claim a MAL id and they disagree. AniList wins (it is the canonical id space
        // here) but this is a genuine upstream data conflict and silently preferring one would
        // hide it. If a MAL-Sync bridge result later looks wrong for this series, this is why.
        console.error(
          `[manga-metadata] MAL id CONFLICT for AniList manga id ${meta.anilistId}: AniList says ` +
            `idMal=${meta.malId}, the links.al-verified MangaDex record ${record.id} says ` +
            `links.mal=${record.malId}. Keeping AniList's. One of the two upstreams is wrong, and ` +
            `MAL-Sync (which is keyed by MAL id) may therefore bridge to the wrong series.`
        );
      }
    }

    if (enriched.startYear === undefined && typeof record.year === 'number') enriched.startYear = record.year;

    return enriched;
  };
}

// =============================================================================================
// ID BRIDGES
//
// CONTRACT REMINDER, from MangaAggregator.rankedFor: bridges run BEFORE any provider search, in
// array order, and the FIRST non-null answer wins outright — it produces matchConfidence
// 'exact-id' plus `via`, and the provider's search is never issued. A throwing bridge is caught
// and the call falls through to title matching.
//
// THE RULE THAT MAKES DEFAULT-ON BRIDGES SAFE: a bridge that cannot name the id space of the
// provider it was handed MUST return null WITHOUT issuing any upstream request. Both bridges below
// check the provider name (and, for MAL-Sync, the presence of a MAL id) before touching the
// network, so registering them by default costs exactly zero requests for the providers they do
// not cover — and zero for the duck-typed fake providers the offline suites are built from.
// =============================================================================================

/**
 * MangaDex `attributes.links.al` → the MangaDex manga UUID.
 *
 * The strongest bridge in the system, and the reason MangaDex is a verifier rather than the
 * metadata source: MangaDex asserts the AniList id ON the record, so the match is an id equality,
 * not a similarity. It also answers the re-release problem for free — verified live, "One Piece"
 * carries `links.al=30013` while "One Piece (Official Colored)" and "One Piece (Fan Colored)"
 * carry no `al` at all.
 *
 * Only ever answers for MangaDex itself. It knows nothing about any other provider's id space and
 * says so by returning null immediately.
 */
export class MangaDexLinksBridge implements IMangaIdBridge {
  readonly name = 'mangadex-links.al';
  readonly via: MangaMatchVia = 'mangadex-links.al';

  constructor(
    private readonly xref: MangaDexXref,
    /** Provider name to answer for. Matched case-insensitively against `MangaParser.name`. */
    private readonly providerName: string = 'MangaDex',
    /** Notified when MangaDex (or MAL-Sync on its path) refused. See the fault-channel section. */
    private readonly onXrefFault?: MangaXrefFaultObserver
  ) {}

  lookup = async (meta: IMangaMeta, providerName: string): Promise<string | null> => {
    if (String(providerName).toLowerCase() !== this.providerName.toLowerCase()) return null;
    const result = await this.xref.resolveResult(meta);
    if (result.fault) {
      // THE ANSWER IS UNCHANGED — null, so the aggregator falls through to title matching and the
      // candidate is labelled by its own weaker evidence. Only the EXPLANATION is new. Returning
      // anything else here, or throwing, would either fabricate confidence or destroy the degraded
      // answer, and both are worse than the bug being fixed.
      console.warn(
        `[manga-metadata] mangadex-links.al bridge SKIPPED for AniList manga id ${meta.anilistId} → ` +
          `${providerName}: upstream refused (${result.fault.kind} from ${result.fault.source}: ` +
          `${result.fault.detail}) — this is NOT "MangaDex has no record for this series"; falling ` +
          `back to title matching, and the mapping keeps its weaker confidence label`
      );
      notifyFault(this.onXrefFault, {
        stage: 'bridge',
        where: this.name,
        provider: String(providerName),
        anilistId: meta.anilistId,
        fault: result.fault,
        at: Date.now(),
      });
    }
    const record = result.value;
    if (!record) return null;
    console.warn(
      `[manga-metadata] mangadex-links.al bridged AniList manga id ${meta.anilistId} → MangaDex ` +
        `${record.id} (matched by ${record.matchedBy}); this is an id equality, not a title match`
    );
    return record.id;
  };
}

/**
 * MAL-Sync (`api.malsync.moe/mal/manga/<idMal>`) → a provider-specific identifier.
 *
 * Verified alive 2026-08-14: `/mal/manga/13` and `/mal/manga/116778` both return 200 with a
 * `Sites` map keyed by page name, each entry carrying `{identifier, url, aniId, malId, title}`.
 * An unknown id returns a clean 404, so a miss is unambiguous.
 *
 * TWO HARD LIMITS, both structural and neither worked around:
 *   1. IT IS KEYED BY MAL ID. There is no AniList-keyed manga endpoint — `/anilist/manga/105778`
 *      returns 404, verified. A series whose AniList record has no `idMal` is unreachable, unless
 *      {@link VerifiedMangaMetadataResolver} backfilled one from MangaDex's `links.mal`.
 *   2. ITS SITE LIST IS SHORT. [Mangadex, MangaFox, MangaNato, Weebcentral, MangaFire, Comick,
 *      MangaReader, MangaPlus, VIZ]. Against this repo's providers that binds MangaDex, MangaHere
 *      (via MangaFox), MangaKakalot (via MangaNato) and ComicK — and notably NOT MangaPill, which
 *      is in the default working set and therefore has title matching as its only path. See
 *      PROVIDERS_WITHOUT_MALSYNC_COVERAGE in ./manga-xref.ts.
 */
export class MalSyncBridge implements IMangaIdBridge {
  readonly name = 'malsync';
  readonly via: MangaMatchVia = 'malsync';

  constructor(
    private readonly index: MalSyncIndex,
    private readonly bindings: readonly IMalSyncSiteBinding[] = MALSYNC_SITE_BINDINGS,
    /** Notified when MAL-Sync refused. See the fault-channel section at the top of this file. */
    private readonly onXrefFault?: MangaXrefFaultObserver
  ) {}

  /** The binding for a provider, or undefined when MAL-Sync does not cover it. */
  bindingFor = (providerName: string): IMalSyncSiteBinding | undefined =>
    this.bindings.find(b => b.provider.toLowerCase() === String(providerName).toLowerCase());

  lookup = async (meta: IMangaMeta, providerName: string): Promise<string | null> => {
    const binding = this.bindingFor(providerName);
    if (!binding) return null; // uncovered provider — no request
    if (!meta.malId) return null; // no key to look up with — no request; see limit (1) above

    // `lookupResult`, not `lookup`. The legacy `lookup` is literally `(await lookupResult()).value`,
    // which is exactly where the distinction was being thrown away: MAL-Sync's genuine 404 ("this
    // series is in no site map") and MAL-Sync's 429 ("ask me later") both arrived here as `null`,
    // produced zero entries, and returned the same silent null.
    const result = await this.index.lookupResult(meta.malId);
    if (result.fault) {
      console.warn(
        `[manga-metadata] malsync bridge SKIPPED for AniList manga id ${meta.anilistId} → ` +
          `${binding.provider} (malId ${meta.malId}): MAL-Sync refused (${result.fault.kind} from ` +
          `${result.fault.source}: ${result.fault.detail}) — UNKNOWN whether ${binding.site} lists ` +
          `this series; falling back to title matching with the mapping's weaker confidence label ` +
          `intact. This is NOT the same as ${binding.provider} having no MAL-Sync coverage.`
      );
      notifyFault(this.onXrefFault, {
        stage: 'bridge',
        where: this.name,
        provider: String(providerName),
        anilistId: meta.anilistId,
        fault: result.fault,
        at: Date.now(),
      });
      // Same degraded answer as before. See MangaDexLinksBridge for why it must stay null.
      return null;
    }

    const entries = this.index.entriesForSite(result.value, binding.site);
    if (entries.length === 0) return null;

    const entry = pickSiteEntry(entries, meta, `${binding.site} (→ ${binding.provider})`);
    if (!entry) return null;

    const id = binding.toProviderId(entry);
    if (!id) {
      // The site listed the series but the entry could not express an id in the provider's id
      // space. That is a BINDING bug (wrong extractor) or a MAL-Sync shape change, and it is
      // exactly the sort of thing that otherwise degrades silently into "the bridge never fires".
      console.warn(
        `[manga-metadata] malsync bridge: ${binding.site} listed AniList manga id ${meta.anilistId} ` +
          `(malId ${meta.malId}) as "${entry.title}" but no ${binding.provider} id could be extracted ` +
          `from it (identifier=${JSON.stringify(entry.identifier)}, url=${JSON.stringify(entry.url)}) — ` +
          `falling back to title matching`
      );
      return null;
    }
    return id;
  };
}

// =============================================================================================
// FACTORY
// =============================================================================================

/** Everything MangaAggregator needs from the metadata layer, sharing one set of caches. */
export interface IMangaMetadataLayer {
  metadata: IMangaMetadataResolver;
  /**
   * Ordered STRONGEST FIRST, because `rankedFor` takes the first non-null answer:
   * `mangadex-links.al` (an id equality asserted by MangaDex) outranks `malsync` (a crowd-sourced
   * third-party map). For MangaDex specifically both could answer, and the ordering guarantees the
   * verified one wins.
   */
  bridges: IMangaIdBridge[];
  xref: MangaDexXref;
  malsync: MalSyncIndex;
  /**
   * The INVERSE lookup: free text → attested series identities → exact provider ids.
   *
   * Everything else in this layer answers "given an AniList id, which record is this on provider
   * X?". A provider whose own search endpoint is unusable has the opposite problem, and solving it
   * with the same two upstreams is what lets `demon slayer` reach the slug `kimetsu-no-yaiba` on
   * MangaKakalot/MangaNato — see src/providers/manga/mangakakalot.ts.
   *
   * It is exposed HERE, on the shared layer, for the same reason everything else is: it is built
   * over the same client and the same `MalSyncIndex`, so its MAL-Sync lookups hit caches the
   * bridges have already warmed instead of duplicating them. A provider that accepts one (
   * `MangaKakalot.setAliasResolver`) should be handed this instance rather than building its own.
   */
  aliases: MangaAliasResolver;
  /**
   * EVERY UPSTREAM REFUSAL THE LAYER HIT, readable without having wired anything up front.
   *
   * This is the consumable end of ./manga-xref.ts's fault vocabulary, and the answer to "how does a
   * caller tell a bridge that was SKIPPED from a bridge that answered 'no such mapping'?" — both
   * still produce a null id and an honest, degraded mapping; only the skipped one appears here.
   *
   * Read `faults.forAnilistId(id)` after a `/manga/info` call to explain that call, or
   * `faults.summary()` for a diagnostics endpoint. A rising `byKind['rate-limited']` is an outage;
   * an empty log while mappings come back 'unverified' means the bridges really did look.
   */
  faults: MangaXrefFaultLog;
}

export interface IMangaMetadataLayerOptions extends IVerifiedMangaMetadataResolverOptions {
  /** Override the MAL-Sync base url (tests, mirrors). */
  malSyncBaseUrl?: string;
  /** Override the MangaDex API base url. */
  mangaDexApiUrl?: string;
  /** Override the AniList GraphQL url used by the alias resolver (tests, mirrors). */
  aniListApiUrl?: string;
  /** Override the site→provider bindings. */
  bindings?: readonly IMalSyncSiteBinding[];
  /**
   * Reuse an existing fault log instead of the fresh one the factory would build. Useful when
   * several layers should report into one diagnostics surface; unnecessary otherwise.
   */
  faultLog?: MangaXrefFaultLog;
}

/**
 * Build the metadata layer over one axios client.
 *
 * THE CLIENT MUST BE THE AGGREGATOR'S OWN. `MangaAggregator.client` is public precisely so the
 * offline suites can swap `client.defaults.adapter` for a fake and have the REAL wiring run with
 * no network. Sharing that instance is what makes MangaDex and MAL-Sync fall under the same fake
 * adapter as AniList; giving this layer a private client of its own would leave two thirds of it
 * untestable offline and quietly reachable from a test run.
 *
 * CACHE SHARING IS THE POINT OF THE FACTORY. `MangaDexXref` is handed the same `MalSyncIndex` the
 * MAL-Sync bridge uses, and the resolver is handed the same `MangaDexXref` the links.al bridge
 * uses. So a single `/manga/info/:id` call — resolver, then a bridge pass per provider — costs at
 * most one MAL-Sync GET and one or two MangaDex GETs in total, not one per provider per bridge.
 * `TtlCache` additionally deduplicates the concurrent fan-out, so even the first, cold call issues
 * each request exactly once.
 *
 * NOTE ON RATE GATING: `RateGate` is installed as an interceptor on each PROVIDER's axios client,
 * so these AniList/MangaDex/MAL-Sync requests are NOT gated by it — they are not provider traffic.
 * They are bounded instead by construction: ≤1 MAL-Sync + ≤3 MangaDex requests per AniList id,
 * memoised for hours and shared across the whole fan-out.
 */
export const createMangaMetadataLayer = (
  client: AxiosInstance,
  base: IMangaMetadataResolver,
  options: IMangaMetadataLayerOptions = {}
): IMangaMetadataLayer => {
  const malsync = new MalSyncIndex(client, options.malSyncBaseUrl);
  const xref = new MangaDexXref(client, malsync, options.mangaDexApiUrl);
  const faults = options.faultLog ?? new MangaXrefFaultLog();
  // ONE observer, fanned to both channels. The log always records (so a caller that wired nothing
  // can still find out); the caller's own observer, if any, runs after and cannot suppress the log.
  const onXrefFault: MangaXrefFaultObserver = event => {
    faults.record(event);
    notifyFault(options.onXrefFault, event);
  };
  return {
    metadata: new VerifiedMangaMetadataResolver(base, xref, { ...options, onXrefFault }),
    bridges: [
      new MangaDexLinksBridge(xref, 'MangaDex', onXrefFault),
      new MalSyncBridge(malsync, options.bindings, onXrefFault),
    ],
    xref,
    malsync,
    // Same client, same MalSyncIndex — so an alias lookup reuses whatever the bridges already cached.
    aliases: new MangaAliasResolver(client, malsync, options.aniListApiUrl),
    faults,
  };
};

/**
 * Registry introspection for /manga diagnostics — what is bridged, what is not, and on what
 * evidence. The coverage limits are DOCUMENTED here rather than solved, which is the accepted
 * position: MAL-Sync's site list simply does not cover most of this repo's providers.
 */
export const describeMangaMetadataLayer = (
  bindings: readonly IMalSyncSiteBinding[] = MALSYNC_SITE_BINDINGS,
  /** Pass `layer.faults` to include the live refusal picture. Omitted ⇒ the static description only. */
  faults?: MangaXrefFaultLog
) => ({
  canonicalIdSpace: 'AniList Media(type: MANGA)',
  verifier: 'MangaDex attributes.links.al (a hard external id asserted on the record)',
  bridges: [
    { name: 'mangadex-links.al', via: 'mangadex-links.al', covers: ['MangaDex'] },
    { name: 'malsync', via: 'malsync', covers: bindings.map(b => b.provider) },
  ],
  malSyncBindings: bindings.map(b => ({ site: b.site, provider: b.provider, provenance: b.provenance })),
  /**
   * The same two upstreams run in reverse for providers whose own search is unreachable. Listed
   * here because it changes what a binding is FOR: the MangaNato binding below is no longer only an
   * id bridge for the aggregator, it is also how a free-text query reaches a slug.
   */
  aliasBridge: {
    purpose: 'free-text query → AniList synonyms + MAL-Sync provider identifier → provider id',
    upstreams: ['AniList Page.media(search, type: MANGA)', 'MAL-Sync /mal/manga/<idMal>'],
    consumers: ['MangaKakalot'],
    ranking: 'best title similarity (subtitle-aware), ties broken by AniList popularity',
    guarantee:
      'an alias is only ATTESTED by AniList/MAL-Sync; the consuming provider must confirm the id ' +
      'exists on its own site before returning it. MangaKakalot confirms against its sitemap index ' +
      'or a bounded number of direct /manga/<slug> fetches.',
  },
  /**
   * "A BRIDGE DID NOT FIRE" HAS TWO CAUSES AND THEY LOOK IDENTICAL FROM OUTSIDE. The static lists
   * below (`malSyncUnmappedSites`, `providersWithoutMalSyncCoverage`) cover the FIRST — structural,
   * permanent, expected. This covers the second — upstream refused, transient, and until this item
   * it was invisible to every caller because `lookup()`/`resolve()` returned the same `null` for
   * both. A non-empty `byKind` here means at least one bridge was skipped rather than answered.
   */
  xrefFaults: faults ? faults.summary() : null,
  malSyncUnmappedSites: MALSYNC_UNMAPPED_SITES.map(s => ({ ...s })),
  providersWithoutMalSyncCoverage: [...PROVIDERS_WITHOUT_MALSYNC_COVERAGE],
  caveats: [
    'MAL-Sync is keyed by MAL id only — /anilist/manga/<id> is 404 (verified). A series with no ' +
      'AniList idMal is unreachable unless MangaDex links.mal backfills one.',
    'AniList returns chapters:null and volumes:null for every RELEASING series, so there is no ' +
      'chapter-count backstop — and none is faked here. B3 turns this uncertainty into tiers.',
    'A MAL-Sync site can list several records for one series (colour/volume re-releases share both ' +
      'malId and aniId). The single-record case is a pure id lookup; the multi-record case is ' +
      'tie-broken by title and logged as such.',
  ],
});
