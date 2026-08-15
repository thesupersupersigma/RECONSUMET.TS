import { AxiosInstance } from 'axios';

import { safeErrorString } from '../../utils/cf-solver';
import {
  MALSYNC_SITE_BINDINGS,
  MALSYNC_UNMAPPED_SITES,
  PROVIDERS_WITHOUT_MALSYNC_COVERAGE,
  MalSyncIndex,
  MangaDexXref,
  pickSiteEntry,
  type IMalSyncSiteBinding,
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

  constructor(
    /** B1's `AniListMangaMetadataResolver`, or any other AniList-speaking resolver. */
    private readonly base: IMangaMetadataResolver,
    private readonly xref: MangaDexXref,
    options: IVerifiedMangaMetadataResolverOptions = {}
  ) {
    this.enrichTitles = options.enrichTitles ?? true;
    this.backfillMalId = options.backfillMalId ?? true;
  }

  resolve = async (anilistId: string | number): Promise<IMangaMeta> => {
    const meta = await this.base.resolve(anilistId);

    // No titles means AniList itself failed (its rate limiting is an HTTP 200 with a populated
    // errors[] and null data, which the base resolver already logs as an UPSTREAM fault). Spending
    // MangaDex and MAL-Sync requests on a series we know nothing about would turn one upstream
    // outage into three, and the aggregator is about to skip every provider anyway.
    if (!Array.isArray(meta.titles) || meta.titles.length === 0) return meta;

    let record;
    try {
      record = await this.xref.resolve(meta);
    } catch (err) {
      // MangaDexXref already swallows its own errors; this is belt-and-braces so a metadata
      // resolver can never be the reason a whole /manga/info call fails.
      console.error(
        `[manga-metadata] MangaDex cross-reference threw for AniList manga id ${meta.anilistId} ` +
          `(continuing with AniList-only metadata): ${safeErrorString(err)}`
      );
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
    private readonly providerName: string = 'MangaDex'
  ) {}

  lookup = async (meta: IMangaMeta, providerName: string): Promise<string | null> => {
    if (String(providerName).toLowerCase() !== this.providerName.toLowerCase()) return null;
    const record = await this.xref.resolve(meta);
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
    private readonly bindings: readonly IMalSyncSiteBinding[] = MALSYNC_SITE_BINDINGS
  ) {}

  /** The binding for a provider, or undefined when MAL-Sync does not cover it. */
  bindingFor = (providerName: string): IMalSyncSiteBinding | undefined =>
    this.bindings.find(b => b.provider.toLowerCase() === String(providerName).toLowerCase());

  lookup = async (meta: IMangaMeta, providerName: string): Promise<string | null> => {
    const binding = this.bindingFor(providerName);
    if (!binding) return null; // uncovered provider — no request
    if (!meta.malId) return null; // no key to look up with — no request; see limit (1) above

    const payload = await this.index.lookup(meta.malId);
    const entries = this.index.entriesForSite(payload, binding.site);
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
}

export interface IMangaMetadataLayerOptions extends IVerifiedMangaMetadataResolverOptions {
  /** Override the MAL-Sync base url (tests, mirrors). */
  malSyncBaseUrl?: string;
  /** Override the MangaDex API base url. */
  mangaDexApiUrl?: string;
  /** Override the site→provider bindings. */
  bindings?: readonly IMalSyncSiteBinding[];
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
  return {
    metadata: new VerifiedMangaMetadataResolver(base, xref, options),
    bridges: [new MangaDexLinksBridge(xref), new MalSyncBridge(malsync, options.bindings)],
    xref,
    malsync,
  };
};

/**
 * Registry introspection for /manga diagnostics — what is bridged, what is not, and on what
 * evidence. The coverage limits are DOCUMENTED here rather than solved, which is the accepted
 * position: MAL-Sync's site list simply does not cover most of this repo's providers.
 */
export const describeMangaMetadataLayer = (bindings: readonly IMalSyncSiteBinding[] = MALSYNC_SITE_BINDINGS) => ({
  canonicalIdSpace: 'AniList Media(type: MANGA)',
  verifier: 'MangaDex attributes.links.al (a hard external id asserted on the record)',
  bridges: [
    { name: 'mangadex-links.al', via: 'mangadex-links.al', covers: ['MangaDex'] },
    { name: 'malsync', via: 'malsync', covers: bindings.map(b => b.provider) },
  ],
  malSyncBindings: bindings.map(b => ({ site: b.site, provider: b.provider, provenance: b.provenance })),
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
