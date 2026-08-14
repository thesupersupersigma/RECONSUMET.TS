import axios, { AxiosInstance } from 'axios';

import { IMangaInfo, MangaParser } from '../../models';
import { compareTwoStrings } from '../../utils/utils';
import { graphqlErrorsSummary, safeErrorString } from '../../utils/cf-solver';
import MangaDex from '../manga/mangadex';
import MangaHere from '../manga/mangahere';
import MangaPill from '../manga/mangapill';

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
const MAX_CANDIDATES = 3; // top-N kept per provider, for the B3 verification pass to probe

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
 * B1 only ever emits 'unverified' unless an id bridge is injected (see {@link IMangaIdBridge});
 * B3 populates the middle tier.
 */
export type MangaMatchConfidence = 'exact-id' | 'metadata' | 'unverified';

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
 * 'external' IS populated — MangaDex surfaces `readable: false` + `externalUrl`, and
 * {@link chapterUnavailability} reads them. The other three are still typed-only, waiting on
 * ComicK/AsuraScans to expose the equivalent flags.
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
  pages?: number; // page COUNT (a real number); only MangaDex reports it up front
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
  /** Client-facing image URL. Identity unless an `imageProxy` is injected — see B4 TODO below. */
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
  /** Present iff `provider` is null. Same role as getEpisodes()'s `reason`. */
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
// SEAMS FOR B2 (metadata layer) AND B3 (confidence tiers)
//
// Typed here, injected through the constructor, and DISPATCHED below — but with no
// implementations, so B2/B3 are additions rather than rewrites. Nothing in this file reaches
// api/src, and nothing in api/src needs to change when they land.
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
 * TODO(B2): the metadata layer. B1 ships {@link AniListMangaMetadataResolver} — AniList only,
 * titles + the fields B3 will need — and nothing else. B2 supplies a resolver that ALSO consults
 * MangaDex `attributes.links` and MAL-Sync. Injected, so B2 replaces it without touching this file.
 */
export interface IMangaMetadataResolver {
  resolve(anilistId: string | number): Promise<IMangaMeta>;
}

/**
 * TODO(B2): an id bridge — the thing that turns a fuzzy title match into an 'exact-id' one.
 * Two are planned:
 *   * `mangadex-links.al` — GET /manga?...&includes[]= then compare `attributes.links.al`.
 *   * `malsync`           — GET api.malsync.moe/mal/manga/<idMal>, which names provider ids outright.
 * `lookup` returns the provider-specific id, or null when the bridge has nothing to say.
 * DISPATCH IS ALREADY WIRED (see rankedFor) — B2 only has to write the object.
 */
export interface IMangaIdBridge {
  readonly name: string;
  readonly via: MangaMatchVia;
  lookup(meta: IMangaMeta, providerName: string): Promise<string | null>;
}

/**
 * TODO(B3): the confidence classifier. Given a title-matched candidate, decide whether the
 * metadata agrees strongly enough to promote 'unverified' → 'metadata'. B1 injects
 * {@link unverifiedClassifier}, which promotes nothing, so every non-bridged mapping is honestly
 * labelled 'unverified'. 'exact-id' is decided before this runs (a bridge outranks any heuristic).
 */
export interface IMangaMatchClassifier {
  classify(
    candidate: { provider: string; id: string; title: string; score: number; raw: any },
    meta: IMangaMeta
  ): MangaMatchConfidence | Promise<MangaMatchConfidence>;
}

/** B1 default: never promotes. Replaced wholesale by B3. */
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

/** Shape of a provider id. Recorded, never assumed — MangaDex ids are v4 UUIDs, everything else
 *  uses path slugs, and code that string-matches a slug shape breaks on MangaDex. */
export type IdShape = 'uuid' | 'slug';

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
// MangaDex, MangaHere and MangaPill are the three manga providers confirmed working. The other
// providers in ../manga are either being repaired (VyvyManga, MangaKakalot) or deleted
// (brmangas, mangahost, mangareader, readmanga) in this same wave, so this file imports NONE of
// them: a provider that ships broken must not be able to break the aggregator's module graph.
// Adding one later is a single entry in this array plus its traits.
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
 * TODO(B4): the POLICY (what the numbers are per deployment, whether 429 triggers backoff, and
 * whether the budget is per-request or per-API-key) belongs with the API layer. This is the seam.
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
 * Read defensively — these are optional fields on `[x: string]: unknown` provider models, so a
 * provider that never sets them simply yields `undefined` and nothing changes for it.
 */
const chapterUnavailability = (raw: any): IChapterUnavailable | undefined => {
  const externalUrl = asText(raw?.externalUrl);
  // `readable === false` is the explicit signal; only MangaDex sets it today. Anything else
  // (undefined, true) is NOT treated as unavailable — absence of evidence is not evidence.
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
  /** TODO(B2) — default is AniList-only. */
  metadata?: IMangaMetadataResolver;
  /** TODO(B2) — default is none, so nothing is ever labelled 'exact-id'. */
  bridges?: IMangaIdBridge[];
  /** TODO(B3) — default promotes nothing, so everything title-matched is 'unverified'. */
  classifier?: IMangaMatchClassifier;
  /**
   * TODO(B4) — turns a raw upstream image URL into the client-facing one. The API layer injects a
   * builder for `/manga/image?url=…&ref=…`; the aggregator has no business knowing its own origin,
   * so the default is identity and `img === rawImg`.
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
 * WHERE THE ANIME VERSION'S TIER-2 *VERIFICATION* WOULD GO, THERE IS NOTHING. `verifyMatch` there
 * rejects on (a) a leaked AniList id, (b) a season-ordinal contradiction, (c) an episode-count
 * backstop. Manga has no seasons, so (b) does not exist; AniList reports `chapters: null` for
 * every RELEASING series, so (c) has no manga analogue and must not be faked. (a) is real but
 * needs an id bridge — that is B2, and the dispatch for it is already wired in `rankedFor`.
 * Until then every title match is labelled 'unverified' and the label travels WITH the mapping,
 * which is exactly why manga-routes.mjs puts `matchConfidence` on MangaMapping and the anime
 * route has no such field.
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
    this.metadata = options.metadata ?? new AniListMangaMetadataResolver(this.client);
    this.bridges = options.bridges ?? [];
    this.classifier = options.classifier ?? unverifiedClassifier;
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
   * TIER 1: top-N title candidates for one provider. No re-ranking pass — the anime version's
   * season/part/year/format adjustment has no manga analogue (see the header). The slot where a
   * re-rank WOULD go is B3's classifier, which runs per candidate below.
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
   *      and no title fuzziness can override it. DISPATCH ONLY — B1 registers no bridges.
   *   2. Title similarity, then the classifier's verdict ('metadata' or 'unverified'). B1's
   *      classifier promotes nothing.
   * A provider that throws degrades to "no candidates from this provider", logged with its real
   * error — never a silent empty.
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

        // 1) id bridges — TODO(B2) supplies these; the dispatch is live so B2 is purely additive.
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
            confidence = await this.classifier.classify({ ...mapping, raw }, meta);
          } catch (err) {
            // A broken classifier must degrade to the HONEST label, never to a confident one.
            console.error(
              `[manga-aggregator] match classifier threw for ${name} candidate "${mapping.title}" ` +
                `(labelling 'unverified'): ${safeErrorString(err)}`
            );
          }
          mappings.push({ ...mapping, matchConfidence: confidence });
        }
        return [key, mappings] as const;
      })
    );
    return { meta, byProvider: new Map(entries) };
  };

  /** Map an AniList manga id to the best match per provider (for /manga/info). Cheap — no chapter
   *  fetches. Every mapping carries its own `matchConfidence`; see the class header for why. */
  getMappings = async (anilistId: string | number): Promise<IMangaMapping[]> => {
    const { byProvider } = await this.rankedFor(anilistId);
    const best: IMangaMapping[] = [];
    for (const list of byProvider.values()) if (list.length) best.push(list[0]);
    return best.sort((a, b) => b.score - a.score);
  };

  /**
   * Chapters for an AniList manga id. Walks providers in preference order (requested first, then
   * the configured order) and returns the first that yields a non-empty chapter list. If nothing
   * does, returns an empty result WITH a `reason` rather than a bare `[]`.
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
   * TODO(B4): if the reader needs a guaranteed order, it belongs in the API layer where a
   * "numeric where possible, stable otherwise" rule can be stated and tested explicitly.
   */
  getChapters = async (
    anilistId: string | number,
    opts: { provider?: string; lang?: string } = {}
  ): Promise<IMangaChaptersResult> => {
    const lang = (opts.lang ?? DEFAULT_LANG).toLowerCase();
    const { byProvider } = await this.rankedFor(anilistId);
    const requestedId = String(anilistId);

    const order = [opts.provider, ...this.providerNames].filter(Boolean) as string[];
    const tried = new Set<string>();
    const skippedForLang: string[] = [];
    let sawCandidates = false;
    let sawEmptyList = false;

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
          return {
            provider: candidate.provider,
            providerId: candidate.id,
            matchConfidence: candidate.matchConfidence,
            ...(candidate.via ? { via: candidate.via } : {}),
            lang,
            chapters,
          };
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
