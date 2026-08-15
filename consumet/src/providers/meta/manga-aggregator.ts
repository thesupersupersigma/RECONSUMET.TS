import axios, { AxiosInstance } from 'axios';

import { IMangaInfo, MangaParser } from '../../models';
import { compareTwoStrings } from '../../utils/utils';
import { graphqlErrorsSummary, safeErrorString } from '../../utils/cf-solver';
import MangaDex from '../manga/mangadex';
import MangaHere from '../manga/mangahere';
import MangaPill from '../manga/mangapill';
// Rewritten this wave and verified end to end (search -> info -> chapters -> pages -> real image
// bytes) before being registered here. `Mangasee123` is the class name only — the site it scrapes
// is now weebcentral.com and it reports itself as 'WeebCentral'.
import AsuraScans from '../manga/asurascans';
import FlameScans from '../manga/flamescans';
import Mangasee123 from '../manga/mangasee123';
// B2's metadata layer. Imported for its FACTORY only — ./manga-metadata imports nothing but types
// back from this file, so the emitted CommonJS has a single require() edge and no cycle.
import { createMangaMetadataLayer } from './manga-metadata';
// B3's confidence classifier, imported the same way and for the same reason: ./manga-classifier
// imports only TYPES back from this file, so there is one require() edge and no cycle.
import { createMangaMatchClassifier } from './manga-classifier';

const ANILIST_GRAPHQL = 'https://graphql.anilist.co';

// ---------------------------------------------------------------------------------------------
// WHY THIS IS A SIBLING OF ./aggregator.ts AND NOT A SUBCLASS OF IT
//
// AnimeAggregator is welded to AnimeParser end to end: `readonly providers: AnimeParser[]`,
// `rankedMatches(provider: AnimeParser, …)`, `getEpisodes` returning `IAnimeEpisode[]`, and
// `getSources`/`getSourcesAll` calling `provider.fetchEpisodeSources`. Manga providers extend
// MangaParser, which declares only `fetchMangaInfo` and `fetchChapterPages` and has NO
// `fetchEpisodeSources` at all — the only common ancestor is BaseParser. Extending would mean
// either any-casting the provider array (throwing away the type safety that is that file's main
// defence) or generifying all 512 lines of it. So: same structure, same concurrency discipline,
// same error-handling discipline, same result envelopes — separate file.
//
// WHAT DELIBERATELY DOES NOT CARRY OVER (each divergence is commented where it lands):
//   * `detectSeasonNumber` / `detectPart` / SEASON_BONUS / SEASON_PENALTY — manga has no seasons.
//   * `EPISODE_COUNT_TOLERANCE` — AniList returns `chapters: null` for any RELEASING manga, and
//     even a finished count disagrees with providers that split chapters, number decimals (100.5)
//     or carry an "Official Colored" re-release as a separate series. There is no manga analogue
//     of the episode-count backstop and faking one would be worse than having none.
//   * A single global cache policy for media URLs — see IMangaPageCachePolicy: MangaDex page hosts
//     expire in minutes, scanlation CDNs are effectively immutable. Per provider, never global.
//   * A universal `lang` filter — see IMangaProviderTraits.langs. `lang` is first-class on
//     MangaDex, embedded in the chapter id on MangaPark, and simply does not exist on
//     MangaHere/MangaPill. Pretending it is universal would make the filter a no-op or a lie.
//
// WHAT THIS ADDS THAT THE ANIME SIDE HAS NO NEED FOR:
//   * Alt-title matching (manga romanisations vary far more than anime ones).
//   * Per-provider upstream rate gating + a per-call request budget (see RateGate). Neither
//     MangaDex nor MangaHere implements any throttling or 429 retry, and MangaHere issues one
//     upstream call PER PAGE, serially — a 166-page chapter is ~500 requests.
// ---------------------------------------------------------------------------------------------

// --- matching tunables (deliberately inherited from ./aggregator.ts so the two behave alike) ---
const TITLE_FLOOR = 0.35; // a candidate must clear this on title alone — metadata never rescues a bad title
// top-N kept per provider. All of them are classified, then re-sorted confidence-first — which is
// why keeping more than one matters: a provider's best-SPELLED hit is regularly a re-release or a
// novelisation, and the corroborated candidate is the second or third row.
const MAX_CANDIDATES = 3;

/** Fallback translated language when a caller does not ask for one. Matches /manga/read's default. */
export const DEFAULT_LANG = 'en';

// =============================================================================================
// PUBLIC TYPES
//
// These mirror the JSDoc typedefs already committed at api/src/manga-routes.mjs (MangaMapping /
// MangaChapter / MangaPage). That file is the contract; B4 wires the two together, so a field
// rename here is rework there. Anything added below that the route does not document is
// ADDITIVE and optional.
// =============================================================================================

/**
 * How strongly a provider mapping is believed to be the requested series. Ordered strongest first.
 *   'exact-id'   — an id bridge named this provider id outright (MangaDex `attributes.links.al`
 *                  equal to the requested AniList id, or MAL-Sync via idMal).
 *   'metadata'   — title similarity PLUS start-year / countryOfOrigin / format agreement.
 *   'unverified' — title similarity alone. Served, but LABELLED, never silently.
 *
 * ALL THREE TIERS ARE LIVE. 'exact-id' comes from the id bridges in ./manga-metadata.ts,
 * 'metadata' from `MetadataMatchClassifier` in ./manga-classifier.ts, and 'unverified' is what
 * anything else honestly is. There is NO fourth, count-based tier: see the note on
 * EPISODE_COUNT_TOLERANCE in the header and `describeMangaMatchClassifier().refusals`.
 */
export type MangaMatchConfidence = 'exact-id' | 'metadata' | 'unverified';

/**
 * Sort key for {@link MangaMatchConfidence}, strongest first. Exported because ordering by
 * confidence and only THEN by title score is what stops a colour re-release or a novelisation with
 * a marginally better string match from being handed back as a provider's best mapping.
 */
export const MANGA_CONFIDENCE_RANK: Readonly<Record<MangaMatchConfidence, number>> = {
  'exact-id': 0,
  metadata: 1,
  unverified: 2,
};

/** Strongest confidence first, then best title score. The ordering used everywhere mappings rank. */
export const byMangaConfidenceThenScore = (a: IMangaMapping, b: IMangaMapping): number =>
  MANGA_CONFIDENCE_RANK[a.matchConfidence] - MANGA_CONFIDENCE_RANK[b.matchConfidence] || b.score - a.score;

/** What produced an 'exact-id' match. Open-ended on purpose — B2 may add bridges. */
export type MangaMatchVia = 'mangadex-links.al' | 'malsync' | (string & {});

/** One AniList MANGA search hit. Mirrors IAggregatorResult, minus `totalEpisodes`. */
export interface IMangaAggregatorResult {
  id: string; // AniList manga id — a DIFFERENT id space from AniList anime ids
  malId?: number;
  title: { romaji?: string; english?: string; native?: string };
  image?: string;
  /** AniList `chapters`. **null for every RELEASING series** — never treat this as a count backstop. */
  totalChapters?: number;
  type?: string; // MANGA | NOVEL | ONE_SHOT
  status?: string;
}

/** One provider's best guess at "this AniList manga". Mirrors MangaMapping in manga-routes.mjs. */
export interface IMangaMapping {
  provider: string;
  id: string; // provider-specific manga id — a v4 UUID on MangaDex, a path slug everywhere else
  title: string; // the provider's own primary title for that match
  score: number; // best title similarity (0..1) across primary AND alt titles, pre-heuristic
  matchConfidence: MangaMatchConfidence;
  via?: MangaMatchVia; // only set for 'exact-id'
}

/**
 * Why a chapter exists in the list but will yield zero pages.
 *   'external'  — MangaDex `attributes.externalUrl` (the chapter is hosted off-site)
 *   'no-images' — ComicK's empty `md_images`
 *   'locked'    — AsuraScans `is_locked`
 *   'premium'   — AsuraScans `is_premium`
 * All four fail SILENTLY upstream (200 + empty list), which is why they need to be modelled at all.
 *
 * 'external', 'locked' and 'premium' are all POPULATED now: MangaDex surfaces `readable: false` +
 * `externalUrl`, AsuraScans surfaces `isLocked`/`isPremium`/`unlockTime`, and
 * {@link chapterUnavailability} reads both sets — specific reasons first, since AsuraScans sets
 * the generic flags too. 'no-images' remains typed-only; ComicK is not in the default registry and
 * exposes no equivalent flag.
 */
export interface IChapterUnavailable {
  reason: 'external' | 'no-images' | 'locked' | 'premium';
  detail?: string;
}

/** Mirrors MangaChapter in manga-routes.mjs. */
export interface IAggregatedMangaChapter {
  id: string; // provider chapter id, passed straight back to /manga/read
  title: string;
  /**
   * A STRING, never a number. Providers emit '100.5', 'Extra', 'Oneshot', '' — `Number()` on any
   * of those is either lossy or NaN, and sorting numerically reorders decimal chapters wrongly.
   */
  chapterNumber?: string;
  volumeNumber?: string; // string for the same reason ('TBD', 'Extra')
  // page COUNT (a real number). Reported up front by MangaDex and AsuraScans only — measured live
  // 2026-08-14: MangaDex 425/425 chapters and AsuraScans 201/201 carry a non-zero count, while
  // FlameComics and WeebCentral carry none at all. Absent elsewhere, so never rely on it.
  pages?: number;
  /**
   * Translated language of THIS chapter. Real per-chapter data on MangaDex; stamped from the
   * provider's declared single language on English-only providers (MangaHere, MangaPill), where
   * it is a fact rather than a guess; undefined when the provider genuinely does not say.
   */
  lang?: string;
  releaseDate?: string;
  /** Set when the chapter is listed but known to be unreadable. See {@link IChapterUnavailable}. */
  unavailable?: IChapterUnavailable;
}

/** Mirrors MangaPage in manga-routes.mjs. */
export interface IAggregatedMangaPage {
  /**
   * 1-based, and RE-DERIVED FROM ARRAY ORDER — not copied from the provider. Every provider
   * numbers differently and none is reliably 1-based: MangaHere emits 0-based indices (two
   * different ones, depending on which of its two page paths ran), MangaDex parses digits out of
   * the image FILENAME, MangaPill scrapes the literal string "page N" out of the DOM. Array order
   * is the only thing all three get right, so that is what the page number is built from.
   */
  page: number;
  /** Whatever number the provider itself claimed, kept for diagnosis. Never used for ordering. */
  providerPage?: number;
  /** Client-facing image URL. Identity unless an `imageProxy` is injected; the API layer injects
   *  one, so over HTTP this is a `/manga/image?url=…&ref=…` link. See {@link IMangaAggregatorOptions.imageProxy}. */
  img: string;
  /** The upstream URL, unproxied. Mirrors /watch's `rawUrl`. */
  rawImg: string;
}

/**
 * How long a provider's PAGE URLS may be cached. Per provider, never global:
 *   * MangaDex hands out a per-request at-home host that expires in ~15 minutes. Caching those
 *     long-term serves dead URLs.
 *   * Scanlation CDNs (AsuraScans, FlameComics — confirmed; MangaHere/MangaPill — not confirmed)
 *     serve content-addressed paths that are stable for a year.
 */
export interface IMangaPageCachePolicy {
  ttlSeconds: number;
  /** true only where the URL is genuinely content-addressed and confirmed stable. */
  immutable: boolean;
  /** Human-readable justification — this field exists so nobody has to re-derive the TTL. */
  note: string;
}

/** Envelope for {@link MangaAggregator.getChapters}. Mirrors the anime getEpisodes() contract. */
export interface IMangaChaptersResult {
  provider: string | null;
  providerId?: string;
  matchConfidence: MangaMatchConfidence | null;
  via?: MangaMatchVia;
  /** The language actually served. May differ from nothing — providers that cannot serve the
   *  requested language are SKIPPED rather than silently answering in another one. */
  lang?: string;
  chapters: IAggregatedMangaChapter[];
  /**
   * ALWAYS present when `provider` is null — that is the whole payload of a no-match answer, and it
   * is the same role getEpisodes()'s `reason` plays.
   *
   * ALSO present, since the servability policy landed, on the one DEGRADED success: a chapter list
   * that was served even though not a single chapter in it is readable (see
   * {@link MangaAggregator.getChapters}). It is prose for a human — a client that needs to branch
   * reads `chapters.every(c => c.unavailable)`, which is the same fact in machine-readable form and
   * has been on the chapter objects since `unavailable` was populated. It is NOT present on a
   * normal success, so `reason == null` still means "nothing to explain".
   */
  reason?: string;
}

/** Envelope for {@link MangaAggregator.getPages}. */
export interface IMangaPagesResult {
  provider: string;
  chapterId: string;
  pages: IAggregatedMangaPage[];
  /** Headers the image fetch needs (Referer, mostly). Undefined when the CDN needs none. */
  headers?: Record<string, string>;
  /** Per-provider, see {@link IMangaPageCachePolicy}. */
  cache: IMangaPageCachePolicy;
}

// =============================================================================================
// THE INJECTION SEAMS: metadata layer (B2) and confidence classifier (B3)
//
// Typed here, injected through the constructor, and DISPATCHED below. BOTH ARE NOW IMPLEMENTED and
// registered by default — the metadata layer in ./manga-metadata.ts, the classifier in
// ./manga-classifier.ts — and both remain fully replaceable through {@link IMangaAggregatorOptions},
// which is what lets the offline suites drive real wiring with fakes. Nothing in this file reaches
// api/src, and nothing in api/src had to change when they landed.
// =============================================================================================

/** AniList manga metadata used for matching. The manga analogue of AniMeta. */
export interface IMangaMeta {
  anilistId: string;
  /** english, romaji, native, ...synonyms — matched against ALL of them. */
  titles: string[];
  malId?: number;
  /** AniList `chapters`. **null for every RELEASING series** — do NOT build a count backstop on it. */
  chapters?: number;
  volumes?: number;
  startYear?: number;
  /** JP | KR | CN | TW — the manga/manhwa/manhua axis. B3's 'metadata' tier uses this. */
  countryOfOrigin?: string;
  format?: string; // MANGA | NOVEL | ONE_SHOT
  status?: string; // RELEASING | FINISHED | ...
}

/**
 * The metadata layer. B1 shipped {@link AniListMangaMetadataResolver} — AniList only, titles plus
 * the fields B3 needs — as the default.
 *
 * B2 LANDED: the default is now `VerifiedMangaMetadataResolver` from ./manga-metadata, which
 * DECORATES the AniList one (AniList stays canonical) and cross-references MangaDex by
 * `attributes.links.al` to fill holes: alt titles for provider search reach, `idMal` when AniList
 * has none, `startYear` when AniList has none. It never overwrites what AniList stated.
 */
export interface IMangaMetadataResolver {
  resolve(anilistId: string | number): Promise<IMangaMeta>;
}

/**
 * An id bridge — the thing that turns a fuzzy title match into an 'exact-id' one.
 * `lookup` returns the provider-specific id, or null when the bridge has nothing to say.
 *
 * B2 LANDED both planned bridges (see ./manga-metadata), registered by default in this order:
 *   * `mangadex-links.al` — MangaDex asserts the AniList id ON the record, so the match is an id
 *     equality. Also separates "(Official Colored)" re-releases for free: verified live, only the
 *     base One Piece record carries `links.al`.
 *   * `malsync` — GET api.malsync.moe/mal/manga/<idMal>, which names provider ids outright.
 *     Covers MangaDex, MangaHere (via MangaFox) and MangaKakalot (via MangaNato); notably NOT
 *     MangaPill, which therefore has title matching as its only path.
 *
 * THE INVARIANT THAT KEEPS DEFAULT REGISTRATION FREE: a bridge that cannot name the id space of
 * the provider it was handed returns null WITHOUT issuing any upstream request.
 */
export interface IMangaIdBridge {
  readonly name: string;
  readonly via: MangaMatchVia;
  lookup(meta: IMangaMeta, providerName: string): Promise<string | null>;
}

/**
 * The confidence classifier. Given a title-matched candidate, decide whether the metadata agrees
 * strongly enough to promote 'unverified' → 'metadata'. Runs PER CANDIDATE, and 'exact-id' is
 * decided before it ever runs (a bridge outranks any heuristic and skips the search entirely).
 *
 * B3 LANDED: the default is now `MetadataMatchClassifier` from ./manga-classifier — exact
 * provider-primary-title equality plus a corroborating start-year / countryOfOrigin / format
 * field, with contradictions as vetoes. It reads NO chapter or volume count; that refusal is the
 * whole point and is argued at length in that file's header.
 *
 * `raw` is the untouched provider search result, so alt titles, year and type are all reachable.
 *
 * THE SAFETY PROPERTY, which is deliberate and is mutation-tested: a classifier that THROWS is
 * caught by {@link MangaAggregator} and the candidate stays 'unverified'. A bug in a heuristic can
 * therefore never manufacture confidence — it can only fail to grant it.
 */
export interface IMangaMatchClassifier {
  classify(
    candidate: { provider: string; id: string; title: string; score: number; raw: any },
    meta: IMangaMeta
  ): MangaMatchConfidence | Promise<MangaMatchConfidence>;
}

/**
 * Never promotes. Was B1's default and is no longer installed by default, but it stays exported
 * because it is the one-line way for a caller to opt out of tier 2 entirely — pass
 * `classifier: unverifiedClassifier` and every non-bridged mapping is labelled 'unverified' again.
 */
export const unverifiedClassifier: IMangaMatchClassifier = { classify: () => 'unverified' };

// =============================================================================================
// PROVIDER REGISTRY
// =============================================================================================

/**
 * How a provider expresses translated language. Purely descriptive — the FILTER runs off
 * `langs`, because that is the only field that states what the provider can serve today.
 */
export type LangModel =
  | 'per-chapter' // MangaDex: a real translatedLanguage field on every chapter
  | 'in-chapter-id' // MangaPark: the language is a segment of the chapter id
  | 'none'; // MangaHere / MangaPill: single-language site, no language concept at all

/** Shape of a provider id. Recorded, never assumed — code that string-matches a slug shape breaks
 *  on MangaDex. Four shapes are in the registry today: v4 UUIDs (MangaDex), path slugs (most),
 *  26-char ULIDs (WeebCentral) and bare integers (FlameComics). 'ulid' and 'numeric' are NOT
 *  'slug': a caller that sanitises a slug (lowercasing, stripping non-`[a-z0-9-]`) would mangle a
 *  ULID, and one that assumes a slug is human-readable will render "104" as a title. */
export type IdShape = 'uuid' | 'slug' | 'ulid' | 'numeric';

export interface IMangaProviderTraits {
  idShape: IdShape;
  langModel: LangModel;
  /**
   * Languages this provider can ACTUALLY serve today — not what the site theoretically hosts.
   * MangaDex is listed as ['en'] even though it is multilingual, because
   * `MangaDex.fetchMangaInfo` hardcodes `translatedLanguage[]=en` in its feed query. Claiming
   * more here would make `getChapters({ lang: 'pt-br' })` answer with English chapters labelled
   * Portuguese. When that provider gains a lang parameter, widen this array — one line.
   */
  langs: readonly string[];
  /** Sustainable upstream request rate. MangaDex documents ~5 req/s; the rest are unmeasured. */
  requestsPerSecond: number;
  /** Result count asked of `search()`. Low on MangaDex because its search fires one EXTRA
   *  cover-art request PER RESULT, serially — 20 results is 21 gated requests. */
  searchLimit: number;
  /** Circuit breakers, in upstream requests, for one aggregator call. See RateGate.withBudget. */
  budgets: { chapterList: number; chapterPages: number; search: number };
  pageUrlCache: IMangaPageCachePolicy;
  /** Headers the provider's IMAGE CDN requires. Empty object when it needs none. */
  imageHeaders: Record<string, string>;
}

/** A registered provider: the parser plus everything the aggregator must know that the
 *  MangaParser interface does not express. */
export interface IMangaProviderEntry {
  parser: MangaParser;
  traits: IMangaProviderTraits;
  /** Installed lazily on first use; see {@link MangaAggregator.gateFor}. */
  gate: RateGate;
}

/** Traits for a provider registered without any (fake providers in tests, future providers a
 *  caller drops in). Deliberately pessimistic: single English language, modest rate, short cache. */
export const DEFAULT_TRAITS: IMangaProviderTraits = {
  idShape: 'slug',
  langModel: 'none',
  langs: ['en'],
  requestsPerSecond: 4,
  searchLimit: 20,
  budgets: { chapterList: 16, chapterPages: 64, search: 32 },
  pageUrlCache: {
    ttlSeconds: 300,
    immutable: false,
    note: 'unregistered provider — cache policy unknown, assume short-lived',
  },
  imageHeaders: {},
};

// ---------------------------------------------------------------------------------------------
// THE WORKING SET.
//
// SIX providers now, up from three. MangaDex, MangaHere and MangaPill were the wave-1 working set;
// AsuraScans, FlameComics and WeebCentral were rewritten against their current hosts in wave 2 and
// are registered here only because each was re-verified END TO END from the built dist/ before the
// entry was written — search -> fetchMangaInfo -> chapter list -> fetchChapterPages -> an actual
// GET of page 1 confirming magic bytes and a plausible length. A provider whose pipeline could not
// be walked in full does NOT get an entry; a green unit suite is not evidence that a host answers.
//
// Providers still absent are absent on purpose: VyvyManga and MangaKakalot are unrepaired, ComicK
// is unverified (its API 301s), and brmangas/mangahost/mangareader/readmanga were deleted. This
// file imports none of them — a provider that ships broken must not break the module graph.
//
// EVERY `imageHeaders` BELOW IS A MEASUREMENT, NOT A COPY OF WHAT THE PROVIDER EMITS. The three
// new CDNs were each fetched three ways — correct Referer, no Referer, and a hostile
// `https://evil.example.com/` — and returned byte-identical 200s every time, so all three take
// `{}`. AsuraScans and WeebCentral still stamp a Referer on their own page objects for parity with
// their siblings; that is cosmetic, and these traits are what a caller should actually believe.
// (Contrast MangaPill, whose CDN really does 403 without one.) Caveat inherited from the wave:
// every such probe ran from a RESIDENTIAL IP. See the note on each entry.
// ---------------------------------------------------------------------------------------------
export const defaultProviderRegistry = (): { parser: MangaParser; traits: IMangaProviderTraits }[] => [
  {
    parser: new MangaDex(),
    traits: {
      idShape: 'uuid', // v4 UUIDs. Nothing here may assume a slug shape.
      langModel: 'per-chapter',
      // See IMangaProviderTraits.langs: the site is multilingual, this PROVIDER is not (its feed
      // query hardcodes translatedLanguage[]=en).
      langs: ['en'],
      requestsPerSecond: 4, // MangaDex documents ~5 req/s; 4 leaves headroom. It has no 429 retry.
      // 10, not 20: search() fires a serial /cover/<id> request per result, so limit N costs N+1
      // gated requests. Fixing that belongs in the provider (includes[]=cover_art), not here.
      searchLimit: 10,
      // chapterList: fetchMangaInfo pages the feed at 96 chapters/request, so 40 covers ~3,800
      // chapters — more than One Piece — while still stopping a runaway recursion.
      budgets: { chapterList: 40, chapterPages: 8, search: 24 },
      pageUrlCache: {
        ttlSeconds: 600,
        immutable: false,
        note: 'at-home server hands out a per-request host valid ~15 min; 10 min leaves margin',
      },
      imageHeaders: {}, // *.mangadex.network needs no Referer — and MUST NOT see an Origin header
      // (with one present it swaps in a placeholder JPEG, which is exactly what a browser
      // fetch()/XHR sends; the server-side hop in /manga/image is what normalises that).
    },
  },
  {
    parser: new MangaHere(),
    traits: {
      idShape: 'slug',
      langModel: 'none', // English-only site: there is no language axis to filter on
      langs: ['en'],
      // fetchChapterPages issues ONE upstream call PER PAGE, serially (chapterfun.ashx), so a
      // 166-page chapter is ~167 requests and ~15s wall clock — i.e. it already self-throttles to
      // roughly 11 req/s. 10 req/s therefore costs ~nothing on the happy path while still capping
      // the burst. Gating harder here would make a slow provider slower, not safer.
      requestsPerSecond: 10,
      searchLimit: 20,
      // chapterPages 600: 166 pages x up-to-3 retries is ~500 requests worst case. This is a
      // circuit breaker for a runaway chapter, not a throttle.
      budgets: { chapterList: 8, chapterPages: 600, search: 8 },
      pageUrlCache: {
        ttlSeconds: 3600,
        immutable: false,
        note: 'CDN path looks content-addressed but was NOT confirmed stable; 1h is a guess, not a measurement',
      },
      imageHeaders: { Referer: 'http://www.mangahere.cc/' }, // note: plain http, that is its real baseUrl
    },
  },
  {
    parser: new MangaPill(),
    traits: {
      idShape: 'slug',
      langModel: 'none',
      langs: ['en'],
      requestsPerSecond: 6,
      searchLimit: 20,
      budgets: { chapterList: 8, chapterPages: 8, search: 8 },
      pageUrlCache: {
        ttlSeconds: 3600,
        immutable: false,
        note: 'cdn.readdetectiveconan.com — stability unconfirmed; 1h is a guess, not a measurement',
      },
      // Empirically required: the CDN answers 403 with no Referer and 200 with this one.
      imageHeaders: { Referer: 'https://mangapill.com/' },
    },
  },
  {
    parser: new AsuraScans(),
    traits: {
      // Bare series slug ('solo-leveling'). NOTE the chapter id is '<slug>/chapter/<number>' and
      // therefore CONTAINS SLASHES — anything putting a chapter id in a URL path rather than a
      // query parameter must encode it.
      idShape: 'slug',
      langModel: 'none',
      langs: ['en'],
      requestsPerSecond: 4, // a JSON API, but undocumented and unmeasured — stay polite
      // The provider REFUSES a limit outside 1..50 (upstream silently returns 20 rows above 50
      // rather than clamping), so this must stay in range.
      searchLimit: 20,
      // fetchMangaInfo is 2 parallel requests, fetchChapterPages is 1 (+1 if the HTML fallback
      // engages). These are circuit breakers against a loop, not throttles.
      budgets: { chapterList: 8, chapterPages: 8, search: 8 },
      pageUrlCache: {
        ttlSeconds: 3600,
        immutable: false,
        note: 'cdn.asurascans.com paths are content-addressed and the ?v= suffix is decorative (stripping it returns byte-identical content); not marked immutable because re-uploads were never observed over time',
      },
      // Verified with, without, and with a hostile Referer: byte-identical 200s, image/webp,
      // RIFF/WEBP magic. No hotlink protection.
      imageHeaders: {},
    },
  },
  {
    parser: new FlameScans(),
    traits: {
      // A bare integer series_id ('104'), NOT a slug — it is not human-readable and must not be
      // rendered as a title. Chapter ids are the composite '<series_id>/<token>'.
      idShape: 'numeric',
      langModel: 'none',
      langs: ['en'],
      requestsPerSecond: 4,
      searchLimit: 20, // honoured: search() filters the catalogue client-side and truncates
      // search pulls the WHOLE catalogue in one request (the site ignores its own query string);
      // the /_next/data fast path can cost one extra request when it re-learns a rotated buildId.
      budgets: { chapterList: 8, chapterPages: 8, search: 8 },
      pageUrlCache: {
        ttlSeconds: 3600,
        immutable: false,
        note: 'cdn.flamecomics.xyz/uploads/... is a plain content path with no query string or token; long-term stability not observed, so not immutable',
      },
      // Verified three ways: byte-identical 200s, image/jpeg, JPEG magic, 808,044 bytes matching
      // the size the metadata declares. No hotlink protection. The provider deliberately emits no
      // headerForImage either, so this agrees with it.
      imageHeaders: {},
    },
  },
  {
    parser: new Mangasee123(),
    traits: {
      // 26-char ULIDs, e.g. 01J76XYA2AFH8MNBG4FRCM5JMV. Deliberately NOT 'slug': every legacy
      // mangasee123 slug id is dead and is rejected pre-flight, so any cached id must be
      // re-resolved through search().
      idShape: 'ulid',
      langModel: 'none',
      langs: ['en'],
      requestsPerSecond: 3, // behind Cloudflare, and it already 403s bot UAs — the most cautious
      // 32, and NOT caller-settable: the /search/data endpoint IGNORES `limit` and always returns
      // 32 rows (measured at 5/10/24/32/50/100/200). Claiming 20 here would make the trait a lie
      // and would silently overlap pages for anyone paging on it.
      searchLimit: 32,
      // fetchMangaInfo is 2 requests (the series page embeds only ~9 chapters, so the full list
      // must come from /full-chapter-list); fetchChapterPages is 1.
      budgets: { chapterList: 8, chapterPages: 8, search: 8 },
      pageUrlCache: {
        ttlSeconds: 3600,
        immutable: false,
        note: 'per-series CDN host (official.lowee.us / hot.planeptune.us) with a plain path and no token; host varies per series so URLs are read, never constructed',
      },
      // Verified three ways on official.lowee.us: byte-identical 200s. No hotlink protection.
      // GOTCHA for any caller that picks a decoder or cache key from the URL or Content-Type:
      // page URLs end in .png AND the CDN answers `Content-Type: image/png`, but the BYTES ARE
      // JPEG (ffd8ffe0/JFIF). Confirmed again here at 526,454 bytes. Covers are honest; only page
      // images lie.
      imageHeaders: {},
    },
  },
];

// =============================================================================================
// RATE GATING + REQUEST BUDGET
// =============================================================================================

/**
 * A per-provider request gate: a minimum interval between upstream requests, plus per-call
 * request budgets.
 *
 * WHY IT LIVES IN THE AGGREGATOR AND NOT IN THE PROVIDERS. Neither MangaDex nor MangaHere
 * implements any throttling or 429 retry, and both are being edited by other workstreams. The
 * aggregator is the only place that sees ALL traffic to a provider, so it is the only place a
 * global rate can be enforced.
 *
 * HOW IT REACHES CALLS WE DO NOT MAKE OURSELVES. Gating `fetchChapterPages` would gate ONE call
 * that internally fires 500. So the gate is installed as an axios REQUEST INTERCEPTOR on the
 * provider's own `client` (every provider extends Proxy, which owns an axios instance) — that
 * catches every upstream request the provider makes, including the serial per-page storm.
 * Structural detection, not a cast: a provider without an interceptable client is simply
 * un-gated, and says so in describeProviders().
 *
 * BUDGET SEMANTICS — the honest caveat. A budget is a counter opened for the duration of one
 * aggregator call. Every request through the gate charges EVERY open scope, so two concurrent
 * calls to the same provider cross-charge each other. That is deliberately conservative: the
 * budget is a circuit breaker against a runaway chapter, not an accounting system.
 *
 * STILL OPEN (B4 shipped without it, deliberately): the POLICY — what the numbers are per
 * deployment, whether 429 triggers backoff, and whether the budget is per-request or per-API-key —
 * belongs with the API layer. B4 wired the routes and verified the gate is genuinely attached to
 * every registered provider (describeProviders().rateGated), but left the numbers where they are.
 * This is the seam.
 */
export class RateGate {
  private readonly minIntervalMs: number;
  private nextSlotAt = 0;
  private readonly scopes = new Set<{ used: number; max: number; label: string }>();
  /** Total requests observed. Diagnostics only — describeProviders() reports it. */
  requestCount = 0;

  constructor(requestsPerSecond: number) {
    this.minIntervalMs = requestsPerSecond > 0 ? Math.ceil(1000 / requestsPerSecond) : 0;
  }

  /** Charge every open budget, then wait for this provider's next free slot. */
  acquire = async (): Promise<void> => {
    this.requestCount++;
    for (const scope of this.scopes) {
      scope.used++;
      if (scope.used > scope.max)
        throw new Error(
          `[manga-aggregator] upstream request budget exhausted for ${scope.label}: ` +
            `${scope.used} > ${scope.max}. This is a circuit breaker, not a transport error — ` +
            `either the chapter is pathologically large or the provider is looping.`
        );
    }
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.minIntervalMs;
    const wait = slot - now;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  };

  /** Run `fn` with a request budget open. Always closes it, including on throw. */
  withBudget = async <T>(max: number, label: string, fn: () => Promise<T>): Promise<T> => {
    const scope = { used: 0, max, label };
    this.scopes.add(scope);
    try {
      return await fn();
    } finally {
      this.scopes.delete(scope);
    }
  };
}

/** Marker so the interceptor is installed exactly once per axios instance. */
const GATED = '__mangaAggregatorGated';

/**
 * Install `gate` on the provider's axios client. Returns false when the provider has no
 * interceptable client (fake providers in tests, or any future provider that does not extend
 * Proxy) — an un-gated provider still works, it just is not throttled, and that fact is reported
 * rather than hidden.
 */
const installRateGate = (parser: MangaParser, gate: RateGate): boolean => {
  const client: any = (parser as any).client;
  if (typeof client?.interceptors?.request?.use !== 'function') return false;
  if (client[GATED]) return true;
  client.interceptors.request.use(async (config: any) => {
    await gate.acquire();
    return config;
  });
  client[GATED] = true;
  return true;
};

// =============================================================================================
// NORMALISATION HELPERS
//
// Every manga provider emits a different shape for the same idea, and none of them matches the
// route contract. These are the adapters. They are total: given garbage they return undefined,
// never throw, and never coerce a chapter number to a Number.
// =============================================================================================

const pickTitle = (t: any): string =>
  typeof t === 'string' ? t : t?.english ?? t?.romaji ?? t?.native ?? t?.userPreferred ?? '';

/** Trim to a non-empty string, or undefined. `String(100.5)` is '100.5' — that is the point. */
const asText = (v: unknown): string | undefined => {
  if (v === null || v === undefined || typeof v === 'object') return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
};

const firstText = (raw: any, keys: string[]): string | undefined => {
  for (const key of keys) {
    const v = asText(raw?.[key]);
    if (v !== undefined) return v;
  }
  return undefined;
};

/**
 * Collect every title a provider result offers, for matching. Manga romanisations vary far more
 * than anime ones ("Kaguya-sama wa Kokurasetai" / "Kaguya Wants To Be Confessed To" / "かぐや様は
 * 告らせたい"), and MangaDex in particular ships a rich `altTitles` array, so matching on the
 * primary title alone loses real matches. This is the one signal the anime aggregator does not use.
 * Tolerates all three shapes providers actually emit: string, string[], and [{ lang: title }].
 */
const candidateTitles = (result: any): string[] => {
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = asText(v);
    if (s) out.push(s);
  };
  push(pickTitle(result?.title));
  const alts = result?.altTitles;
  if (typeof alts === 'string') push(alts);
  else if (Array.isArray(alts))
    for (const alt of alts) {
      if (typeof alt === 'string') push(alt);
      else if (alt && typeof alt === 'object') for (const v of Object.values(alt)) push(v);
    }
  else if (alts && typeof alts === 'object') for (const v of Object.values(alts)) push(v);
  return out;
};

/**
 * The chapter number, AS A STRING. Providers disagree on the key (`chapterNumber` on MangaDex,
 * `chapter` on MangaPill, absent on MangaHere) and on the value ('100.5', 'Extra', 'Oneshot').
 * Falls back to digging a number out of the title, which is the only thing MangaHere gives us.
 */
const chapterNumberOf = (raw: any): string | undefined => {
  const direct = firstText(raw, ['chapterNumber', 'chapter', 'chapterNum', 'number']);
  if (direct !== undefined) return direct;
  const title = typeof raw?.title === 'string' ? raw.title : '';
  const m = title.match(/(?:chapter|chap|ch\.?|#)\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? m[1] : undefined;
};

/**
 * Why this listed chapter will yield zero pages, when the provider says so up front.
 *
 * B1 shipped `IChapterUnavailable` typed but unpopulated, because at the time no provider surfaced
 * the flags. MangaDex now does — it marks external stubs with `readable: false` plus the
 * `externalUrl` the pages really live at — and the two halves landing in the same wave is exactly
 * why they had not been connected. Without this, `getChapters` hands back stubs indistinguishable
 * from real chapters and `getPages` throws on them: live, Chainsaw Man's NEWEST chapter is such a
 * stub, so the aggregator's most obvious call threw on a top-10 title.
 *
 * AsuraScans now supplies the other half. It sets `isLocked`/`isPremium`/`unlockTime` on an
 * early-access chapter, which is why ORDER MATTERS HERE: a locked AsuraScans chapter also carries
 * `readable: false` AND an `externalUrl` (its own on-site reader URL), so checking `external` first
 * would label every early-access chapter 'external' — i.e. "hosted somewhere else", which is the
 * wrong thing to tell a user about a chapter that is on this very site and unlocks on a timer. The
 * specific reasons are therefore tested before the general one, and `unlockTime` is preferred as
 * the detail because "unlocks 2026-08-15T00:05Z" is actionable where a URL that 200s into a
 * paywall is not.
 *
 * Read defensively — these are optional fields on `[x: string]: unknown` provider models, so a
 * provider that never sets them simply yields `undefined` and nothing changes for it.
 */
const chapterUnavailability = (raw: any): IChapterUnavailable | undefined => {
  const externalUrl = asText(raw?.externalUrl);
  const unlockTime = asText(raw?.unlockTime);
  // MOST SPECIFIC FIRST. `isLocked` outranks `isPremium` because AsuraScans sets both together on
  // an early-access chapter and "locked" is the reason the pages are missing; "premium" is how it
  // is monetised. A chapter that is premium but NOT locked is left alone by the provider (it is
  // readable), so reaching the second branch means premium is the operative gate.
  if (raw?.isLocked === true)
    return { reason: 'locked', ...(unlockTime ?? externalUrl ? { detail: unlockTime ?? externalUrl } : {}) };
  if (raw?.isPremium === true)
    return { reason: 'premium', ...(unlockTime ?? externalUrl ? { detail: unlockTime ?? externalUrl } : {}) };
  // `readable === false` is the explicit generic signal; MangaDex sets it for off-site stubs.
  // Anything else (undefined, true) is NOT treated as unavailable — absence of evidence is not
  // evidence.
  if (raw?.readable === false || externalUrl !== undefined)
    return {
      reason: 'external',
      ...(externalUrl !== undefined ? { detail: externalUrl } : {}),
    };
  return undefined;
};

/** Normalise one provider chapter to the route contract. `entry` supplies the language fact. */
const normalizeChapter = (raw: any, traits: IMangaProviderTraits): IAggregatedMangaChapter | null => {
  const id = asText(raw?.id);
  if (!id) return null; // a chapter with no id cannot be read — dropping it beats a 400 later
  const pages = typeof raw?.pages === 'number' && Number.isFinite(raw.pages) ? raw.pages : undefined;
  // On a single-language provider the language is a FACT, not a guess, so stamping it is honest.
  // On a multi-language provider we only report what the chapter itself said.
  const declared = firstText(raw, ['lang', 'language', 'translatedLanguage']);
  const lang = declared ?? (traits.langs.length === 1 ? traits.langs[0] : undefined);
  const unavailable = chapterUnavailability(raw);
  return {
    id,
    title: asText(raw?.title) ?? chapterNumberOf(raw) ?? id,
    chapterNumber: chapterNumberOf(raw),
    volumeNumber: firstText(raw, ['volumeNumber', 'volume', 'vol']),
    ...(pages !== undefined ? { pages } : {}),
    ...(lang !== undefined ? { lang } : {}),
    // MangaHere misspells this as `releasedDate`; MangaDex/route contract use `releaseDate`.
    // The resulting string is NOT of one format — MangaDex/FlameComics give ISO-8601, MangaHere
    // gives 'Nov 05,2018'. Documented on the route typedef; deliberately not normalised here,
    // because guessing a locale for a scraped string is how a wrong date gets invented.
    // `publishAt` is kept LAST and is a trap if promoted: on MangaDex it is a scheduling field
    // parked on a 2037 sentinel for externally-hosted chapters (see MangaDex.chapterReleaseDate),
    // so it would date exactly the unreadable rows wrongly. No provider emits it today.
    ...(firstText(raw, ['releaseDate', 'releasedDate', 'updatedAt', 'publishAt']) !== undefined
      ? { releaseDate: firstText(raw, ['releaseDate', 'releasedDate', 'updatedAt', 'publishAt'])! }
      : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
};

// =============================================================================================
// METADATA RESOLVER (B1 baseline — AniList only)
// =============================================================================================

/**
 * AniList MANGA metadata. Deliberately minimal: enough titles to search with, plus the fields
 * B3's 'metadata' tier will need (startYear, countryOfOrigin, format) and the idMal B2's MAL-Sync
 * bridge will need. It does NOT verify anything — that is B2/B3.
 *
 * NOTE the id space: AniList numbers anime and manga separately (One Piece is anime 21, manga
 * 30013), so `type: MANGA` is not optional here.
 */
export class AniListMangaMetadataResolver implements IMangaMetadataResolver {
  constructor(private readonly client: AxiosInstance) {}

  resolve = async (anilistId: string | number): Promise<IMangaMeta> => {
    const gql = `query ($id: Int) {
      Media(id: $id, type: MANGA) {
        id idMal title { romaji english native } synonyms format status chapters volumes
        countryOfOrigin startDate { year }
      }
    }`;
    const { data } = await this.client.post(ANILIST_GRAPHQL, { query: gql, variables: { id: Number(anilistId) } });
    // Same upstream-fault case ./aggregator.ts logs: AniList answers rate limiting with HTTP 200 +
    // populated errors[] + null data. Without this line it degrades into "no provider had the
    // title" and misdirects diagnosis at the providers.
    const gqlErrors = graphqlErrorsSummary(data);
    if (gqlErrors)
      console.error(
        `[manga-aggregator] AniList meta for manga id ${anilistId} returned HTTP 200 with populated errors[] — ` +
          `UPSTREAM AniList fault (likely rate limiting), NOT a provider fault; mapping will degrade to empty: ${gqlErrors}`
      );
    const m = data?.data?.Media ?? {};
    return {
      anilistId: String(anilistId),
      titles: [m.title?.english, m.title?.romaji, m.title?.native, ...(m.synonyms ?? [])].filter(Boolean),
      malId: m.idMal ?? undefined,
      // null for every RELEASING series — see IMangaMeta.chapters.
      chapters: m.chapters ?? undefined,
      volumes: m.volumes ?? undefined,
      startYear: m.startDate?.year ?? undefined,
      countryOfOrigin: m.countryOfOrigin ?? undefined,
      format: m.format ?? undefined,
      status: m.status ?? undefined,
    };
  };
}

export interface IMangaAggregatorOptions {
  /** Registry entries, or bare parsers (which get {@link DEFAULT_TRAITS}). Default: the working set. */
  providers?: (MangaParser | { parser: MangaParser; traits?: Partial<IMangaProviderTraits> })[];
  /** Default: B2's AniList-primary, MangaDex-verified resolver (see ./manga-metadata). */
  metadata?: IMangaMetadataResolver;
  /** Default: B2's `[mangadex-links.al, malsync]`, strongest first. Pass `[]` to disable bridging. */
  bridges?: IMangaIdBridge[];
  /**
   * Default: B3's `MetadataMatchClassifier` (see ./manga-classifier). Pass
   * {@link unverifiedClassifier} to disable tier 2 and label every non-bridged mapping
   * 'unverified'.
   */
  classifier?: IMangaMatchClassifier;
  /**
   * Turns a raw upstream image URL into the client-facing one. The API layer injects a builder for
   * `/manga/image?url=…&ref=…` (see `createMangaAggregator` in api/src/manga-routes.mjs); the
   * aggregator has no business knowing its own origin, so the default is identity and
   * `img === rawImg`. The referer passed here is the PER-PAGE one where a provider supplies it,
   * which is why the proxy link is built in this seam and not re-derived by the caller afterwards.
   */
  imageProxy?: (rawImg: string, referer?: string) => string;
}

/**
 * MangaAggregator — the manga-side sibling of {@link AnimeAggregator}.
 *
 * Search by AniList (clean GraphQL API, no scraping), then map a title across every configured
 * manga provider so a client can pick any working source per chapter (with fallback). Same
 * two-layer shape as the anime aggregator:
 *   - TIER 1 (cheap, no chapter fetches) — `rankedMatches`: title similarity across the AniList
 *     titles vs the provider's primary AND alt titles, keeping the top-N per provider.
 *     `getMappings` (used by /manga/info) returns only the best per provider.
 *   - TIER 2 (verify where we already fetch) — `getChapters`: walks providers in preference order
 *     and returns the first that yields chapters, falling through with a `reason` rather than
 *     serving nothing silently.
 *
 * WHERE THE ANIME VERSION'S TIER-2 *VERIFICATION* WOULD GO, THERE ARE CONFIDENCE TIERS INSTEAD.
 * `verifyMatch` there rejects on (a) a leaked AniList id, (b) a season-ordinal contradiction,
 * (c) an episode-count backstop. Manga has no seasons, so (b) does not exist; AniList reports
 * `chapters: null` for every RELEASING series, so (c) HAS NO MANGA ANALOGUE and is not faked
 * anywhere in this file or its two neighbours. (a) is answered by B2's id bridges, dispatched in
 * `rankedFor` and registered by default.
 *
 * What replaces the missing backstop is honesty rather than a substitute check: B3's
 * `MetadataMatchClassifier` (./manga-classifier) promotes a candidate to 'metadata' only when the
 * provider's own primary title matches EXACTLY and it publishes a corroborating start year or
 * origin, and anything else stays 'unverified'. Two of the six registered providers (MangaHere,
 * MangaPill) publish no non-title field in a search result at all, so tier 2 is structurally out of
 * reach for them and they are 'exact-id' via a bridge or 'unverified' — that limit is documented in
 * `MANGA_CLASSIFIER_SIGNAL_COVERAGE`, not papered over. The label travels WITH the mapping, which
 * is exactly why manga-routes.mjs puts `matchConfidence` on MangaMapping and the anime route has no
 * such field.
 *
 * CONCURRENCY. Providers fan out with Promise.all + a per-provider catch, exactly as
 * ./aggregator.ts does: one dead provider degrades to "no candidates from this provider" and is
 * logged with its real error, it never sinks the call. Upstream requests are additionally gated
 * per provider (see {@link RateGate}).
 */
class MangaAggregator {
  /**
   * PUBLIC, unlike ./aggregator.ts's private client. The repo's offline-test precedent is to
   * inject a fake axios adapter so the REAL wiring runs with no network; a private client would
   * force the test to either hit AniList or stub the resolver and skip the wiring entirely.
   */
  readonly client: AxiosInstance = axios.create({ timeout: Number(process.env.HTTP_TIMEOUT_MS) || 20000 });
  readonly providers: IMangaProviderEntry[];
  readonly metadata: IMangaMetadataResolver;
  readonly bridges: IMangaIdBridge[];
  readonly classifier: IMangaMatchClassifier;
  private readonly imageProxy: (rawImg: string, referer?: string) => string;

  constructor(options: IMangaAggregatorOptions = {}) {
    const registered = options.providers ?? defaultProviderRegistry();
    this.providers = registered.map(p => {
      const parser: MangaParser = p instanceof MangaParser ? p : (p as any).parser ?? p;
      const overrides = p instanceof MangaParser ? undefined : (p as any).traits;
      const traits: IMangaProviderTraits = { ...DEFAULT_TRAITS, ...(overrides ?? {}) };
      const gate = new RateGate(traits.requestsPerSecond);
      installRateGate(parser, gate);
      return { parser, traits, gate };
    });
    // B2's metadata layer, built over THIS aggregator's axios client so that a test which swaps
    // `agg.client.defaults.adapter` for a fake also captures the MangaDex and MAL-Sync traffic.
    // The resolver DECORATES B1's AniList one rather than replacing it, so AniList stays the
    // canonical id space and its rate-limit detection is unchanged; MangaDex only fills holes.
    // Both bridges and the resolver share one set of caches, so a whole /manga/info call costs at
    // most one MAL-Sync GET and one or two MangaDex GETs no matter how many providers fan out.
    const layer = createMangaMetadataLayer(this.client, new AniListMangaMetadataResolver(this.client));
    this.metadata = options.metadata ?? layer.metadata;
    // Registering bridges by default is only safe because each one returns null WITHOUT issuing an
    // upstream request when it cannot name the given provider's id space — so a registry of
    // duck-typed fakes (every offline suite) pays nothing and behaves exactly as before.
    this.bridges = options.bridges ?? layer.bridges;
    // B3's classifier. Registering it by default is safe for the same structural reason the bridges
    // are: it issues NO requests and reads only fields the provider already put in its own search
    // result, so a registry of duck-typed fakes pays nothing — and a fake that states no year and
    // no type simply cannot be promoted, which is why every pre-B3 offline expectation still holds.
    this.classifier = options.classifier ?? createMangaMatchClassifier();
    this.imageProxy = options.imageProxy ?? (rawImg => rawImg);
  }

  /** Registered provider names, in preference order. */
  get providerNames(): string[] {
    return this.providers.map(e => e.parser.name);
  }

  /**
   * Registry introspection for /manga diagnostics: what each provider is, what languages it can
   * really serve, how its page URLs may be cached, and whether the rate gate actually attached.
   */
  describeProviders = () =>
    this.providers.map(e => ({
      name: e.parser.name,
      idShape: e.traits.idShape,
      langModel: e.traits.langModel,
      langs: [...e.traits.langs],
      requestsPerSecond: e.traits.requestsPerSecond,
      pageUrlCache: e.traits.pageUrlCache,
      rateGated: (e.parser as any)?.client?.[GATED] === true,
      requestCount: e.gate.requestCount,
    }));

  private entryFor = (name: string): IMangaProviderEntry | undefined =>
    this.providers.find(e => e.parser.name.toLowerCase() === String(name).toLowerCase());

  /** AniList MANGA search (no scraping). Mirrors AnimeAggregator.search. */
  search = async (query: string, page = 1, perPage = 15): Promise<IMangaAggregatorResult[]> => {
    const gql = `query ($q: String, $page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(search: $q, type: MANGA, sort: SEARCH_MATCH) {
          id idMal title { romaji english native } coverImage { large } format chapters status
        }
      }
    }`;
    const { data } = await this.client.post(ANILIST_GRAPHQL, { query: gql, variables: { q: query, page, perPage } });
    const gqlErrors = graphqlErrorsSummary(data);
    if (gqlErrors)
      console.error(
        `[manga-aggregator] AniList search("${query}") returned HTTP 200 with populated errors[] — UPSTREAM ` +
          `AniList fault (likely rate limiting), NOT a provider fault; degrading to empty results: ${gqlErrors}`
      );
    return (data?.data?.Page?.media ?? []).map((m: any) => ({
      id: String(m.id),
      malId: m.idMal ?? undefined,
      title: m.title,
      image: m.coverImage?.large,
      totalChapters: m.chapters ?? undefined,
      type: m.format,
      status: m.status,
    }));
  };

  /**
   * TIER 1: top-N title candidates for one provider, ranked by string similarity ALONE. The anime
   * version's season/part adjustment has no manga analogue (see the header), and the year/format
   * adjustment deliberately does not happen here — it happens in `rankedFor`, AFTER the classifier
   * has turned those same fields into a confidence tier, so that one piece of evidence is not spent
   * twice (once nudging a score, once granting a label).
   */
  private rankedMatches = async (
    entry: IMangaProviderEntry,
    meta: IMangaMeta
  ): Promise<{ mapping: IMangaMapping; raw: any }[]> => {
    const name = entry.parser.name;
    const res: any = await entry.gate.withBudget(entry.traits.budgets.search, `${name}.search`, () =>
      // MangaParser.search is (query, ...args) — providers that take fewer parameters ignore the
      // extras, so passing (query, page, limit) is safe across all three and lets MangaDex cap its
      // per-result cover-art fan-out.
      Promise.resolve(entry.parser.search(meta.titles[0], 1, entry.traits.searchLimit))
    );
    const results: any[] = res?.results ?? [];
    if (results.length === 0)
      // The call SUCCEEDED but carried nothing — distinct from a thrown error, and easy to mistake
      // for one when a provider is quietly degraded (200s with empty bodies).
      console.warn(
        `[manga-aggregator] provider ${name}: search("${meta.titles[0]}") for AniList manga id ` +
          `${meta.anilistId} succeeded but returned 0 results — provider degraded or title absent (not an error)`
      );

    const scored: { mapping: IMangaMapping; raw: any; score: number }[] = [];
    for (const r of results) {
      const id = asText(r?.id);
      const primary = pickTitle(r?.title);
      if (!id || !primary) continue;
      const theirs = candidateTitles(r);
      // Best similarity over the FULL cross product of AniList titles x provider titles+alts.
      let best = 0;
      for (const mine of meta.titles)
        for (const t of theirs) {
          const s = compareTwoStrings(mine.toLowerCase(), t.toLowerCase());
          if (s > best) best = s;
        }
      if (best < TITLE_FLOOR) continue;
      scored.push({
        mapping: { provider: name, id, title: primary, score: best, matchConfidence: 'unverified' },
        raw: r,
        score: best,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_CANDIDATES).map(({ mapping, raw }) => ({ mapping, raw }));
  };

  /**
   * Resolve metadata once, then fan out across every provider concurrently.
   *
   * ORDER OF PRECEDENCE, strongest first:
   *   1. An id bridge naming the provider id outright → 'exact-id' (+ `via`). No search needed,
   *      and no title fuzziness can override it. B2's two bridges are registered by default.
   *   2. Title similarity, then the classifier's verdict ('metadata' or 'unverified'). B3's
   *      classifier is registered by default and promotes only on corroborated evidence.
   * Candidates are then re-sorted CONFIDENCE-FIRST, so an evidenced match outranks a better-spelled
   * guess. A provider that throws degrades to "no candidates from this provider", logged with its
   * real error — never a silent empty.
   */
  private rankedFor = async (
    anilistId: string | number
  ): Promise<{ meta: IMangaMeta; byProvider: Map<string, IMangaMapping[]> }> => {
    const meta = await this.metadata.resolve(anilistId);
    if (meta.titles.length === 0) {
      // Nothing to search WITH — every provider gets skipped. Say so, or this reads as "no
      // provider had the title" when the real fault is upstream metadata.
      console.error(
        `[manga-aggregator] AniList meta for manga id ${anilistId} yielded NO titles — skipping all ` +
          `providers (upstream metadata fault, NOT a provider fault)`
      );
      return { meta, byProvider: new Map() };
    }

    const entries = await Promise.all(
      this.providers.map(async (entry): Promise<readonly [string, IMangaMapping[]]> => {
        const name = entry.parser.name;
        const key = name.toLowerCase();

        // 1) id bridges — B2's, registered by default. Each returns null without any upstream
        //    request for a provider whose id space it cannot name, so this loop is free for the
        //    providers it does not cover.
        for (const bridge of this.bridges) {
          try {
            const exactId = await bridge.lookup(meta, name);
            if (exactId) {
              const bridged: IMangaMapping = {
                provider: name,
                id: exactId,
                // The provider's own title is unknown here because a bridge answer needs no
                // provider search. AniList's primary title is the honest stand-in; B2 may choose
                // to backfill it from fetchMangaInfo.
                title: meta.titles[0],
                score: 1,
                matchConfidence: 'exact-id',
                via: bridge.via,
              };
              return [key, [bridged]] as const;
            }
          } catch (err) {
            console.error(
              `[manga-aggregator] id bridge ${bridge.name} failed for provider ${name} / AniList manga id ` +
                `${meta.anilistId} (falling back to title matching): ${safeErrorString(err)}`
            );
          }
        }

        // 2) title matching
        const candidates = await this.rankedMatches(entry, meta).catch(err => {
          console.error(
            `[manga-aggregator] provider ${name}: search("${meta.titles[0]}") for AniList manga id ` +
              `${meta.anilistId} FAILED (degrading to no candidates from this provider): ${safeErrorString(err)}`
          );
          return [] as { mapping: IMangaMapping; raw: any }[];
        });

        const mappings: IMangaMapping[] = [];
        for (const { mapping, raw } of candidates) {
          let confidence: MangaMatchConfidence = 'unverified';
          try {
            // CLAMPED, NOT TRUSTED. Only 'metadata' promotes: 'exact-id' means "an id bridge named
            // this provider id outright" and is decided ABOVE, before the search is even issued, so
            // a heuristic answering 'exact-id' would be claiming evidence that does not exist (and
            // would emit a mapping with no `via`, which nothing downstream could explain). Anything
            // else a classifier returns — a typo, undefined, a future tier this build has never
            // heard of — lands on the honest label rather than being written through.
            const verdict = await this.classifier.classify({ ...mapping, raw }, meta);
            if (verdict === 'metadata') confidence = 'metadata';
            else if (verdict !== 'unverified')
              console.error(
                `[manga-aggregator] match classifier returned ${JSON.stringify(verdict)} for ${name} ` +
                  `candidate "${mapping.title}" — only 'metadata' may promote (an 'exact-id' is a bridge's ` +
                  `answer, never a heuristic's); labelling 'unverified'`
              );
          } catch (err) {
            // A broken classifier must degrade to the HONEST label, never to a confident one.
            console.error(
              `[manga-aggregator] match classifier threw for ${name} candidate "${mapping.title}" ` +
                `(labelling 'unverified'): ${safeErrorString(err)}`
            );
          }
          mappings.push({ ...mapping, matchConfidence: confidence });
        }
        // CONFIDENCE OUTRANKS TITLE SCORE WITHIN A PROVIDER, and this is where a re-release stops
        // beating the base record. `rankedMatches` ordered these by string similarity alone, which
        // is precisely the signal that cannot separate "Solo Leveling" from "Solo Leveling
        // (Volume)" (WeebCentral, both 2018, captured live) or "One Piece" from "One Piece
        // (Official Colored)". Re-sorting here means `getMappings` hands back the best-EVIDENCED
        // candidate rather than the best-SPELLED one, and `getChapters` tries them in that order.
        // Array.prototype.sort is stable, so equal-confidence equal-score candidates keep the
        // provider's own ordering.
        mappings.sort(byMangaConfidenceThenScore);
        return [key, mappings] as const;
      })
    );
    return { meta, byProvider: new Map(entries) };
  };

  /**
   * Map an AniList manga id to the best match per provider (for /manga/info). Cheap — no chapter
   * fetches. Every mapping carries its own `matchConfidence`; see the class header for why.
   *
   * ORDERED BY CONFIDENCE FIRST, then title score. A title score of 1.0 is trivially reached by a
   * novelisation or a colour edition whose name happens to be spelled exactly right, so scoring
   * alone would put an unverified guess above a corroborated match — and a client that takes
   * `mappings[0]` would then read the wrong series. See {@link byMangaConfidenceThenScore}.
   */
  getMappings = async (anilistId: string | number): Promise<IMangaMapping[]> => {
    const { byProvider } = await this.rankedFor(anilistId);
    const best: IMangaMapping[] = [];
    for (const list of byProvider.values()) if (list.length) best.push(list[0]);
    return best.sort(byMangaConfidenceThenScore);
  };

  /**
   * Chapters for an AniList manga id. Walks providers in preference order (requested first, then
   * strongest-confidence first) and returns the first that yields a chapter list it can actually
   * serve. If nothing does, returns an empty result WITH a `reason` rather than a bare `[]`.
   *
   * ===========================================================================================
   * THE SERVABILITY POLICY, AND WHY IT IS A FILTER RATHER THAN A RANKING
   *
   * THE BUG IT EXISTS FOR. Solo Leveling is AniList manga 105398. MangaDex asserts that id on its
   * own record (`attributes.links.al`), so the `mangadex-links.al` bridge names the MangaDex id
   * outright and the mapping is 'exact-id' — the strongest signal this file has, and it is CORRECT:
   * that record really is Solo Leveling. But all 24 of its English chapters are `externalUrl`
   * stubs (the pages live on webnovel.com), so every one of them carries
   * `unavailable: { reason: 'external' }` and `fetchChapterPages` throws on all of them. The
   * obvious user path — list chapters, read the first one — therefore 502'd on a top-10 title while
   * five other registered providers were sitting there with real images.
   *
   * THE ACTUAL DEFECT was not the ordering. It was that ONE ranking key was being asked to answer
   * TWO independent questions:
   *     "is this the right series?"   — id confidence answers this, and answered it perfectly here
   *     "can this provider serve pages?" — id confidence says NOTHING about this
   * A record can be unambiguously the right book and still be a catalogue entry rather than a copy
   * of it. So the two properties get two mechanisms and are never folded into one number:
   *
   *   CONFIDENCE RANKS.  It is the only sort key, and it now sorts ACROSS providers too, not just
   *     within one (`byMangaConfidenceThenScore` over each provider's best candidate, registry
   *     order breaking ties, an explicit `opts.provider` still pinned to the front). Before this,
   *     the cross-provider walk was registry order, which meant a fall-through could hand an
   *     'unverified' title guess to a caller while an 'exact-id' provider sat later in the list.
   *   SERVABILITY ADMITS.  A candidate whose chapter list contains ZERO readable chapters is not
   *     ranked lower — it is INADMISSIBLE as an answer to "give me something to read", exactly like
   *     a candidate whose list came back empty, and the walk continues past it.
   *
   * NOTHING IS THROWN AWAY. The first (i.e. highest-confidence) all-unavailable list is HELD, and
   * if no admissible candidate exists anywhere it is returned as-is — provider, confidence, `via`
   * and every chapter's `unavailable` marker intact — with a `reason` saying why it is degraded.
   * A caller therefore never gets LESS than it got before this policy: the worst case is today's
   * answer plus an explanation, and the common case is a provider that actually works.
   *
   * WHERE THE LINE IS, AND WHY IT IS NOT A TUNABLE. Zero readable chapters, not "mostly
   * unreadable". "Can this provider serve pages for this series" is a boolean, and any percentage
   * threshold would be an invented number that eventually demotes a legitimately mostly-licensed
   * series. A list with GAPS (Chainsaw Man's newest chapter is an external stub; an AsuraScans
   * early-access chapter is `locked` on a timer) is served, because it can be read — the gaps are
   * marked and the caller chooses. That distinction is the whole policy.
   *
   * WHAT WAS CONSIDERED AND REJECTED — each of these fixes Solo Leveling and manufactures a
   * different mystery later, which is precisely the failure mode to avoid:
   *   1. DEMOTE MangaDex, or reorder the registry. Fixes one title by breaking the general case:
   *      Berserk is 425/425 readable on MangaDex, and demoting it hands that series to a scanlation
   *      site matched on title similarity alone. Serving the WRONG SERIES is a worse failure than
   *      serving no pages, because it is silent.
   *   2. FOLD A READABILITY SCORE INTO THE SORT (confidence x readability). Same conflation with a
   *      bigger number. Any single key mixing "is this the right book" with "can I open it" will
   *      eventually rank a confidently-WRONG book above a confidently-right unreadable one, and
   *      neither outcome is explicable from the score afterwards.
   *   3. DETECT AT PAGE-FETCH TIME and re-try another provider inside `getPages`. Chapter ids are
   *      provider-scoped and non-transferable — there is no way to map a MangaDex chapter id onto
   *      an AsuraScans one without a chapter-ALIGNMENT layer that does not exist and would be a new
   *      source of silent wrongness (split chapters, decimals, colour re-releases). It also swaps
   *      the provider out from under a chapter list the caller has already rendered.
   *   4. MARK-AND-RETURN AS THE PRIMARY ANSWER (the brief's third option, taken alone). Honest, but
   *      it does not fix the reported bug: the user's obvious path still ends with nothing to read,
   *      just with better prose. It is the right LAST resort, so that is exactly what it is here.
   *   5. FILTER THE UNREADABLE CHAPTERS OUT of the list. That turns Solo Leveling's MangaDex answer
   *      into an empty list and Chainsaw Man's newest chapter into a hole in the numbering. The
   *      `unavailable` marker exists so the caller can see them, not so we can hide them.
   *
   * COST. One extra `fetchMangaInfo` per rejected candidate — the same cost the pre-existing
   * empty-list fall-through already pays, bounded by the same per-provider budgets.
   * ===========================================================================================
   *
   * LANGUAGE IS A SKIP, NOT A FILTER. A provider that cannot serve the requested language is
   * skipped outright and named in the reason. Post-filtering English chapters by `lang: 'pt-br'`
   * would either return everything (a lie) or nothing (indistinguishable from an outage).
   *
   * ORDER IS THE PROVIDER'S OWN AND IS NOT NORMALISED. Confirmed live: MangaDex returns
   * newest-first (its feed orders volume/chapter DESC), as do MangaHere and MangaPill — so today
   * the three agree, but by coincidence rather than by contract. Sorting here would mean sorting
   * `chapterNumber`, which is deliberately a STRING carrying '100.5', 'Extra' and 'Oneshot': any
   * numeric sort silently reorders decimals and dumps the non-numeric ones somewhere arbitrary.
   * STILL OPEN, and B4 chose to leave it open: `/manga/chapters` returns this order verbatim
   * rather than shipping a sort it could not state precisely. If the reader ever needs a
   * guaranteed order it belongs in the API layer, where a "numeric where possible, stable
   * otherwise" rule can be written down and tested explicitly.
   */
  getChapters = async (
    anilistId: string | number,
    opts: { provider?: string; lang?: string } = {}
  ): Promise<IMangaChaptersResult> => {
    const lang = (opts.lang ?? DEFAULT_LANG).toLowerCase();
    const { byProvider } = await this.rankedFor(anilistId);
    const requestedId = String(anilistId);

    // CONFIDENCE IS THE PRIMARY SORT, ACROSS PROVIDERS AND NOT ONLY WITHIN ONE. `rankedFor` already
    // ordered each provider's own candidates confidence-first; this orders the PROVIDERS by the
    // confidence of their best candidate, with registry position breaking ties (so the working-set
    // order still decides between two equally-evidenced providers, and `Array.prototype.sort`'s
    // stability is not relied on for it). A provider with no candidates sorts last and is skipped by
    // the loop anyway. An explicit `opts.provider` stays pinned to the front — an explicit request
    // outranks every heuristic, including this one.
    const walk = this.providers
      .map((e, index) => {
        const key = e.parser.name.toLowerCase();
        const best = (byProvider.get(key) ?? [])[0];
        return { key, index, rank: best ? MANGA_CONFIDENCE_RANK[best.matchConfidence] : Number.MAX_SAFE_INTEGER };
      })
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(p => p.key);
    const order = [opts.provider, ...walk].filter(Boolean) as string[];
    const tried = new Set<string>();
    const skippedForLang: string[] = [];
    let sawCandidates = false;
    let sawEmptyList = false;
    // The best (= highest-confidence, first-walked) candidate that listed chapters but can serve
    // NONE of them. Held, never discarded — see the servability policy in this method's doc. If the
    // walk finds something admissible this is dropped on the floor; if it does not, this is the
    // answer, and it is strictly more informative than the `{ provider: null, chapters: [] }` the
    // caller would otherwise get.
    let unreadableFallback: IMangaChaptersResult | undefined;

    for (const name of order) {
      const key = name.toLowerCase();
      if (tried.has(key)) continue;
      tried.add(key);
      const entry = this.entryFor(key);
      const candidates = byProvider.get(key) ?? [];
      if (!entry || candidates.length === 0) continue;

      if (!entry.traits.langs.some(l => l.toLowerCase() === lang)) {
        skippedForLang.push(`${entry.parser.name} (serves ${entry.traits.langs.join('/')})`);
        continue;
      }
      sawCandidates = true;

      for (const candidate of candidates) {
        try {
          const info: IMangaInfo = await entry.gate.withBudget(
            entry.traits.budgets.chapterList,
            `${entry.parser.name}.fetchMangaInfo`,
            () => entry.parser.fetchMangaInfo(candidate.id)
          );
          const chapters = (info.chapters ?? [])
            .map(c => normalizeChapter(c, entry.traits))
            .filter((c): c is IAggregatedMangaChapter => c !== null);
          if (chapters.length === 0) {
            // The fetch SUCCEEDED but carried no chapters — distinct from an error, and the
            // classic signature of a quietly-degraded scraper (200s whose selectors stopped matching).
            console.warn(
              `[manga-aggregator] provider ${candidate.provider}: fetchMangaInfo("${candidate.id}") ` +
                `("${candidate.title}") for AniList manga id ${requestedId} succeeded but returned ZERO ` +
                `chapters — skipping candidate (not an error)`
            );
            sawEmptyList = true;
            continue;
          }
          const served: IMangaChaptersResult = {
            provider: candidate.provider,
            providerId: candidate.id,
            matchConfidence: candidate.matchConfidence,
            ...(candidate.via ? { via: candidate.via } : {}),
            lang,
            chapters,
          };
          // THE SERVABILITY FILTER. Not a ranking — see this method's doc. A list with SOME
          // readable chapters is served as it always was (gaps are marked, the caller chooses);
          // a list with NONE cannot answer "give me something to read" no matter how certain we
          // are that it is the right series, so it is held and the walk continues.
          const unreadable = chapters.filter(c => c.unavailable !== undefined);
          if (unreadable.length === chapters.length) {
            const reasons = [...new Set(unreadable.map(c => c.unavailable!.reason))].sort().join('/');
            console.warn(
              `[manga-aggregator] provider ${candidate.provider}: fetchMangaInfo("${candidate.id}") ` +
                `("${candidate.title}") for AniList manga id ${requestedId} listed ${chapters.length} ` +
                `chapter(s) but EVERY ONE is unreadable (${reasons}) — the match is fine ` +
                `(${candidate.matchConfidence}${candidate.via ? ` via ${candidate.via}` : ''}), the provider ` +
                `simply cannot serve pages for it; trying the next candidate/provider and keeping this ` +
                `list as a fallback`
            );
            unreadableFallback ??= {
              ...served,
              reason:
                `served by ${candidate.provider} (${candidate.matchConfidence}` +
                `${candidate.via ? `, via ${candidate.via}` : ''}) but NOT READABLE: all ${chapters.length} ` +
                `chapter(s) are marked unavailable (${reasons}), and no other registered provider ` +
                `offered a readable list for this title. Each chapter carries its own 'unavailable' ` +
                `marker — link out or grey it out rather than calling /manga/read on it.`,
            };
            continue;
          }
          return served;
        } catch (err) {
          // Fall through to the next candidate/provider — but log the REAL failure first, or a
          // provider outage becomes an indistinguishable silent skip.
          console.error(
            `[manga-aggregator] provider ${candidate.provider}: fetchMangaInfo("${candidate.id}") ` +
              `("${candidate.title}") for AniList manga id ${requestedId} FAILED (trying next ` +
              `candidate/provider): ${safeErrorString(err)}`
          );
        }
      }
    }

    // Nothing admissible. A held all-unavailable list beats `{ provider: null, chapters: [] }` on
    // every axis a caller cares about: it names the series, carries the real chapter list, and says
    // per chapter WHY each one cannot be read. Returning null here instead would be discarding
    // evidence we already paid for.
    if (unreadableFallback) return unreadableFallback;

    let reason: string;
    if (!sawCandidates && skippedForLang.length)
      reason =
        `no registered provider serves language '${lang}' for this title — skipped: ` +
        `${skippedForLang.join(', ')}`;
    else if (sawEmptyList) reason = 'providers matched the title but every candidate returned an empty chapter list';
    else reason = 'no provider returned chapters for this title';
    return { provider: null, matchConfidence: null, lang, chapters: [], reason };
  };

  /**
   * Pages for one chapter from a named provider. Mirrors AnimeAggregator.getSources — provider by
   * name, unknown name throws.
   *
   * Three things happen here that no provider does for itself:
   *   1. Pages with no image URL are DROPPED. MangaPill's scraper writes `img: undefined!` when
   *      its `data-src` selector misses; passing that through produces a broken <img> per page.
   *   2. `page` is re-derived from array order (see IAggregatedMangaPage.page).
   *   3. The image Referer is attached from the registry, since /manga/image has to inject it.
   */
  getPages = async (
    providerName: string,
    chapterId: string,
    opts: { lang?: string } = {}
  ): Promise<IMangaPagesResult> => {
    const entry = this.entryFor(providerName);
    if (!entry) throw new Error(`unknown provider: ${providerName}`);
    // `lang` is accepted for symmetry with /manga/read but is only forwarded to providers whose
    // chapter ids are not already language-scoped. On every provider in the B1 working set the
    // chapter id fully determines the language, so this is a no-op — stated, not pretended.
    const extra = entry.traits.langModel === 'per-chapter' && opts.lang ? [opts.lang] : [];

    const raw: any[] = await entry.gate.withBudget(
      entry.traits.budgets.chapterPages,
      `${entry.parser.name}.fetchChapterPages`,
      () => Promise.resolve(entry.parser.fetchChapterPages(chapterId, ...extra))
    );

    const referer = entry.traits.imageHeaders.Referer;
    const pages: IAggregatedMangaPage[] = [];
    let dropped = 0;
    for (const p of raw ?? []) {
      const rawImg = asText(p?.img);
      if (!rawImg) {
        dropped++;
        continue;
      }
      const providerPage = typeof p?.page === 'number' && Number.isFinite(p.page) ? p.page : undefined;
      // A per-page Referer (MangaHere emits `headerForImage`) beats the registry default.
      const pageReferer = asText(p?.headerForImage?.Referer) ?? referer;
      pages.push({
        page: pages.length + 1,
        ...(providerPage !== undefined ? { providerPage } : {}),
        img: this.imageProxy(rawImg, pageReferer),
        rawImg,
      });
    }
    if (dropped > 0)
      console.warn(
        `[manga-aggregator] provider ${entry.parser.name}: fetchChapterPages("${chapterId}") returned ` +
          `${dropped} page(s) with NO image url (dropped, ${pages.length} kept) — the provider's image ` +
          `selector is probably stale`
      );
    if (pages.length === 0)
      // Chapters that exist but yield zero pages are a real, silent upstream case (MangaDex
      // externalUrl, ComicK empty md_images, AsuraScans is_locked). Log it as such rather than
      // letting an empty array read as a transport failure.
      console.warn(
        `[manga-aggregator] provider ${entry.parser.name}: fetchChapterPages("${chapterId}") succeeded ` +
          `but produced ZERO pages — the chapter may be external/locked/premium rather than broken`
      );

    return {
      provider: entry.parser.name,
      chapterId,
      pages,
      ...(Object.keys(entry.traits.imageHeaders).length ? { headers: { ...entry.traits.imageHeaders } } : {}),
      cache: entry.traits.pageUrlCache,
    };
  };
}

export default MangaAggregator;
