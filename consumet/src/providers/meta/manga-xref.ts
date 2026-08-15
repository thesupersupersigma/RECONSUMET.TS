import { AxiosInstance } from 'axios';

import { compareTwoStrings } from '../../utils/utils';
import { safeErrorString } from '../../utils/cf-solver';
import type { IMangaMeta } from './manga-aggregator';

// ---------------------------------------------------------------------------------------------
// THE CROSS-REFERENCE LAYER — hard external ids, never titles.
//
// WHY THIS FILE EXISTS AT ALL. `MangaAggregator` maps an AniList manga id onto provider ids by
// string-similarity of titles, and manga titles are the worst possible thing to match on:
// romanisation is unstandardised ("Na Honjaman Level-Up" / "Solo Leveling" / "Only I Level Up" are
// the same series), every popular title has "(Official Colored)" / "(Fan Colored)" / "(Colored)"
// re-releases carrying near-identical strings, and AniList reports `chapters: null` for every
// RELEASING series so there is no count backstop to catch a wrong pick.
//
// The demonstration, captured live 2026-08-14 (and pinned as a fixture in
// test/manga-metadata-bridges.test.mjs) — MangaDex `GET /manga?title=Solo Leveling&limit=8`:
//
//   ade0306c-… links.al=179445  "Na Honjaman Level Up: Ragnarok"   <- MangaDex's own TOP hit
//   32d76d19-… links.al=105398  "Na Honjaman Level-Up"             <- the series actually asked for
//   83ff1ad8-… links.al=(none)  "Solo Leveling: Arise"
//   685383ff-… links.al=(none)  "Solo Leveling - The revenge of sung jin-woo (Doujinshi)"
//   …3 more doujinshi/side records…
//
// Title similarity against AniList id 105398 ("Solo Leveling") ranks the SEQUEL first and cannot
// reach the right record at all — its primary title is a Korean romanisation with almost no
// bigram overlap with "Solo Leveling". Comparing `links.al` to '105398' finds it exactly, and the
// record it finds carries 37 alt titles which then make every OTHER provider's title search work.
// That is the whole argument for this layer in one response.
//
// TWO SOURCES, DELIBERATELY RANKED:
//
//   1. MangaDex `attributes.links.al` — AUTHORITATIVE. MangaDex's own staff assert the AniList id
//      on the record. Verified live: Chainsaw Man `links.al='105778'`, `links.mal='116778'`; One
//      Piece `links.al='30013'`, `links.mal='13'`. Critically, the re-release records do NOT carry
//      it — `GET /manga?ids[]=` over the three MAL-Sync Chainsaw Man/One Piece candidates returns
//      `al=30013` on the base record and `al=null` on both "(Official Colored)" and "(Fan
//      Colored)". So `links.al` disambiguates re-releases with hard data, not heuristics.
//
//   2. MAL-Sync (`api.malsync.moe/mal/manga/<idMal>`) — a third-party id map keyed by MAL id,
//      naming an exact provider identifier per site. Weaker than (1) because it is crowd-sourced
//      and unversioned, but it is a DIRECT id lookup (no search), and its Mangadex entries are
//      exactly the candidate set that (1) then verifies. The two compose: MAL-Sync proposes,
//      links.al disposes.
//
// NEITHER IS THE METADATA SOURCE. AniList `Media(type: MANGA)` is the canonical id space and the
// only title/format/year authority here; see ./manga-metadata.ts. MangaDex has no canonical
// single-language title (`ja-ro`, `ko-ro` and `en` appear as the primary within ONE response), so
// promoting it to primary would be a downgrade.
// ---------------------------------------------------------------------------------------------

const MALSYNC_BASE = 'https://api.malsync.moe';
const MANGADEX_API = 'https://api.mangadex.org';

/**
 * MangaDex's default search hides `erotica`/`pornographic`. We ask for all four because every
 * candidate is confirmed by a hard id afterwards — widening the net cannot widen the match, it can
 * only stop a legitimately-rated series from being invisible to the verifier.
 */
const ALL_CONTENT_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'] as const;

/** AniList titles tried against MangaDex search before the fallback path gives up. */
const TITLE_PROBES = 2;
/** Results per MangaDex title probe. `links.al` is scanned across all of them. */
const TITLE_PROBE_LIMIT = 10;

/** Positive answers are stable for months; an hours-long TTL is generous, not risky. */
const TTL_HIT_MS = 6 * 60 * 60 * 1000;
/** "Looked and it genuinely is not there" — cheap to re-check, but not on every provider. */
const TTL_MISS_MS = 10 * 60 * 1000;
/** A transport failure is NOT evidence of absence, so it is barely cached — only enough to stop a
 *  single fan-out from firing the same doomed request once per provider. */
const TTL_ERROR_MS = 30 * 1000;

/** Entries kept per cache. Small: one entry per series actually requested in the last few hours. */
const CACHE_MAX = 500;

// =============================================================================================
// A TINY TTL CACHE WITH IN-FLIGHT DEDUPLICATION
// =============================================================================================

/**
 * Memoises one async lookup per key, with a per-OUTCOME ttl and — the part that matters here —
 * in-flight deduplication.
 *
 * WHY THE IN-FLIGHT MAP IS NOT OPTIONAL. `MangaAggregator.rankedFor` fans out across every
 * provider with `Promise.all`, and each provider runs every bridge. Without dedup, three
 * providers x two bridges is up to six simultaneous identical MAL-Sync requests for one call —
 * all issued before any of them could have populated a plain value cache. With it, the fan-out
 * costs exactly one upstream request and the other five await the same promise.
 */
class TtlCache<K, V> {
  private readonly values = new Map<K, { value: V; expiresAt: number }>();
  private readonly inFlight = new Map<K, Promise<V>>();

  /** Diagnostics only — `describe()` on the layer reports these. */
  hits = 0;
  misses = 0;

  constructor(private readonly ttlFor: (value: V) => number) {}

  get = async (key: K, load: () => Promise<V>): Promise<V> => {
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.hits++;
      return cached.value;
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      this.hits++;
      return pending;
    }
    this.misses++;
    const promise = load()
      .then(value => {
        // Map preserves insertion order, so the first key is the oldest — a one-line LRU-ish bound.
        if (this.values.size >= CACHE_MAX) {
          const oldest = this.values.keys().next();
          if (!oldest.done) this.values.delete(oldest.value);
        }
        this.values.set(key, { value, expiresAt: Date.now() + this.ttlFor(value) });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  };

  /** Drops everything. For long-lived processes and for tests. */
  clear = (): void => {
    this.values.clear();
    this.inFlight.clear();
  };
}

// =============================================================================================
// MAL-SYNC
// =============================================================================================

/** One MAL-Sync site entry. Shapes verified live against `/mal/manga/13` and `/mal/manga/116778`. */
export interface IMalSyncEntry {
  /**
   * The provider's own identifier — a MangaDex UUID, a MangaFox/MangaNato slug, a Weebcentral
   * ULID, a MangaFire short code. A NUMBER on the `external: true` sites (MangaPlus, VIZ), where it
   * is a positional index rather than an id, which is one reason those sites are unmapped below.
   */
  identifier?: string | number;
  url?: string;
  title?: string;
  /** The site name, echoing the `Sites` key. */
  page?: string;
  type?: string;
  malId?: number;
  /**
   * PRESENT ON SOME SITES ONLY. Verified live: Mangadex/MangaFox/MangaNato/Weebcentral/MangaFire
   * entries carry `aniId`; Comick/MangaReader/MangaPlus/VIZ entries do not. When present it is a
   * free hard check of the AniList id and a mismatch REJECTS the entry (see {@link pickSiteEntry}).
   */
  aniId?: number;
  /** true on MangaPlus/VIZ — official readers we cannot scrape. Never bridged. */
  external?: boolean;
}

/** `GET /mal/manga/<malId>`. 404 for an unknown id — verified live with malId 99999999. */
export interface IMalSyncPayload {
  id?: number;
  title?: string;
  url?: string;
  type?: string;
  /** site name → identifier → entry. A site can hold SEVERAL entries; see {@link pickSiteEntry}. */
  Sites?: Record<string, Record<string, IMalSyncEntry>>;
}

/**
 * Turns one MAL-Sync site entry into the id the PROVIDER's own `fetchMangaInfo`/`search` speaks.
 * Returns null when the entry cannot express one.
 */
export type MalSyncIdExtractor = (entry: IMalSyncEntry) => string | null;

/** How a site name in MAL-Sync's `Sites` map binds to a provider in this repo. */
export interface IMalSyncSiteBinding {
  /** Key inside `Sites`, spelled exactly as MAL-Sync spells it (note: 'Mangadex', lowercase d). */
  site: string;
  /** `MangaParser.name` of the provider this site is. Matched case-insensitively. */
  provider: string;
  toProviderId: MalSyncIdExtractor;
  /** How this binding was established. Written out so nobody has to re-derive it. */
  provenance: string;
}

/** `identifier` verbatim — correct wherever the site's identifier IS the provider's id. */
const identifierAsId: MalSyncIdExtractor = entry => {
  const id = entry?.identifier;
  if (typeof id === 'number') return null; // positional index on the `external` sites — not an id
  const s = typeof id === 'string' ? id.trim() : '';
  return s === '' ? null : s;
};

/** The last path segment of `url`, for sites whose `identifier` is NOT what the provider consumes. */
const urlTailAsId =
  (marker: string): MalSyncIdExtractor =>
  entry => {
    const url = typeof entry?.url === 'string' ? entry.url : '';
    const idx = url.indexOf(marker);
    if (idx < 0) return null;
    const tail = url
      .slice(idx + marker.length)
      .split(/[?#]/)[0]
      .replace(/\/+$/, '')
      .trim();
    return tail === '' ? null : tail;
  };

/**
 * MAL-Sync site → provider bindings. THIS IS THE COVERAGE STORY, and it is deliberately short:
 * MAL-Sync's full site list is [Mangadex, MangaFox, MangaNato, Weebcentral, MangaFire, Comick,
 * MangaReader, MangaPlus, VIZ] and most of those are not providers this repo has.
 *
 * Every `provenance` below is either a live probe with its evidence, or is labelled INFERENCE.
 * The two "same operator, do the slugs match?" questions were open when this file was written and
 * are now CLOSED — both were one probe, both came back yes, and the negative controls make the
 * 200s mean something.
 */
export const MALSYNC_SITE_BINDINGS: readonly IMalSyncSiteBinding[] = [
  {
    site: 'Mangadex',
    provider: 'MangaDex',
    toProviderId: identifierAsId,
    provenance:
      "VERIFIED LIVE 2026-08-14. MAL-Sync's Mangadex `identifier` is the v4 UUID MangaDex itself " +
      'uses: the three identifiers returned for malId 13 were echoed back by ' +
      'GET /manga?ids[]=… as real records, the base one carrying links.al=30013. Note this ' +
      'binding is the WEAK path for MangaDex — MangaDexXref verifies it against links.al before ' +
      'MalSyncBridge is ever consulted, because the bridges run in order and the links.al bridge ' +
      'is registered first.',
  },
  {
    site: 'MangaFox',
    provider: 'MangaHere',
    toProviderId: identifierAsId,
    provenance:
      'VERIFIED LIVE 2026-08-14 — was INFERENCE ("same operators?"), is now fact. MangaFox/fanfox ' +
      'and MangaHere share a slug space. Probes, with the negative control that makes the 200s ' +
      "mean something: MAL-Sync's MangaFox identifier `one_piece` → " +
      'https://www.mangahere.cc/manga/one_piece/ = 200, <title>One Piece Manga - Read One Piece ' +
      'Online at MangaHere</title>; `chainsaw_man` → 200, <title>Chainsaw Man Manga …at ' +
      'MangaHere</title>; CONTROL `zzz_not_a_real_series_xyzzy` → 302 (redirected away, not a ' +
      'page). MangaHere.fetchMangaInfo builds `${baseUrl}/manga/${mangaId}`, so the identifier ' +
      'drops straight in. CAVEAT: a resolving slug is not a stocked series — chainsaw_man is a ' +
      "16KB page with zero chapter rows vs one_piece's 616KB. That is handled downstream by the " +
      "aggregator's existing \"succeeded but returned ZERO chapters → skip candidate\" path.",
  },
  {
    site: 'MangaNato',
    provider: 'MangaKakalot',
    toProviderId: identifierAsId,
    provenance:
      'VERIFIED LIVE 2026-08-14 — was INFERENCE, is now fact, and it is STRUCTURAL rather than ' +
      "coincidental: this repo's MangaKakalot provider already scrapes baseUrl " +
      "'https://www.manganato.gg', which is the exact host MAL-Sync's MangaNato urls point at, " +
      "and its fetchMangaInfo builds `${baseUrl}/manga/${slug}`. Probes: identifier " +
      '`chainsaw-man` → 200, <title>Chainsaw Man Manga Free … | MangaNato</title>; `one-piece` → ' +
      '200, <title>One Piece Manga Free … | MangaNato</title>; CONTROL ' +
      '`zzz-not-a-real-series-xyzzy` → 404 <title>Error 404</title>. MangaKakalot is not in the ' +
      'default registry yet, so this binding is inert until it is registered — it costs nothing ' +
      'and is ready.',
  },
  {
    site: 'Comick',
    provider: 'ComicK',
    toProviderId: urlTailAsId('/comic/'),
    provenance:
      "INFERENCE — NOT live-verified. Read from src/providers/manga/comick.ts: search() emits " +
      '`id: manga.slug` and fetchMangaInfo does GET /comic/${mangaId}, so the provider id space is ' +
      "the SLUG (e.g. '02-chainsaw-man'). MAL-Sync's Comick `identifier` is the hid " +
      "('rXYgRqhf'), which is a DIFFERENT id space — hence urlTailAsId('/comic/') rather than " +
      'identifierAsId. An attempt to confirm against api.comick.io returned 301 for both the slug ' +
      'and the hid (the API host redirects), so neither form was actually exercised. ComicK is ' +
      'not in the default registry, so this binding is inert. Also note the wave-1 Cloudflare ' +
      "lesson: ComicK answers 200 to an honest 'Consumet/1.0' UA and 403 to a browser-claiming " +
      'one, so do not "fix" a 403 here by escalating the disguise.',
  },
];

/**
 * MAL-Sync sites this repo deliberately does NOT bind, and why. Exported so the coverage limit is
 * a documented artefact rather than folklore — the task brief asked for it to be documented, not
 * solved.
 */
export const MALSYNC_UNMAPPED_SITES: readonly { site: string; reason: string }[] = [
  { site: 'Weebcentral', reason: 'no Weebcentral provider in this repo' },
  { site: 'MangaFire', reason: 'no MangaFire provider in this repo' },
  {
    site: 'MangaReader',
    reason:
      'src/providers/manga/mangareader.ts was DELETED in wave 1 as a dead provider. Re-adding the ' +
      "provider would make this binding trivial — MAL-Sync's identifier is the numeric suffix " +
      "mangareader.to uses ('96' ⇒ /chainsaw-man-96).",
  },
  {
    site: 'MangaPlus',
    reason:
      'official Shueisha reader, `external: true`, and its `identifier` is a positional index ' +
      '(0/1/2) rather than an id. Not scrapeable and not an id space.',
  },
  { site: 'VIZ', reason: 'official reader, `external: true`, same positional-index identifier problem' },
];

/**
 * Providers in the working set with NO MAL-Sync coverage at all. Stated because "the bridge did
 * not fire" for these is expected behaviour, not a bug to be chased.
 */
export const PROVIDERS_WITHOUT_MALSYNC_COVERAGE: readonly string[] = [
  'MangaPill', // absent from MAL-Sync's site list entirely — title matching is the ONLY path
  'MangaPark',
  'AsuraScans',
  'FlameScans',
  'VyvyManga',
  'MangaSee', // MAL-Sync dropped it; the site is defunct
];

/**
 * Re-release markers. A MAL-Sync site can list four records for one series ("One Piece", "One
 * Piece (Colored)", "One Piece - Digital Colored Comics", "One Piece (Colored)" — all four
 * returned live for malId 13 under MangaNato), and they all carry the SAME malId and aniId, so no
 * id can separate them. Only the title can, so only here is a title consulted at all.
 */
const VARIANT_MARKER =
  /\b(colou?red|full[\s-]?colou?rs?|official\s+volume|digital(?:ly)?[\s-]?colou?red|fan[\s-]?colou?red|pre-?serial\w*|doujin\w*|book\s+version|remake|reprint|anthology)\b/i;

/** How much a re-release marker costs a candidate, when no AniList title carries the same marker. */
const VARIANT_PENALTY = 0.35;

/**
 * Choose one entry from a site's list.
 *
 * THE HONEST DESCRIPTION OF WHAT THIS DOES. The brief's claim that MAL-Sync gives "an exact
 * provider identifier with zero title matching" is true for a site holding ONE entry, which is the
 * common case, and that path is taken verbatim below with no scoring at all. When a site holds
 * several — always because of colour/volume re-releases — some tiebreak is unavoidable, and the
 * only signal that separates them is the title. Rather than pretend otherwise, the multi-entry
 * branch scores titles explicitly, penalises re-release markers, and LOGS what it discarded.
 *
 * `aniId` is checked first and is not a tiebreak but a filter: when MAL-Sync states an AniList id
 * and it disagrees with the one asked for, the entry is wrong and is dropped outright.
 */
export const pickSiteEntry = (
  entries: IMalSyncEntry[],
  meta: IMangaMeta,
  siteLabel = 'unknown'
): IMalSyncEntry | null => {
  const wantAniId = Number(meta.anilistId);
  const usable = entries.filter(e => {
    if (!e || e.external === true) return false;
    // aniId is present on ~half the sites. When present it is authoritative for rejection: a
    // mismatch means MAL-Sync itself maps this record to a different AniList series.
    if (typeof e.aniId === 'number' && Number.isFinite(wantAniId) && e.aniId !== wantAniId) return false;
    return true;
  });
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0]; // the zero-title-matching path

  const titles = meta.titles.filter(t => typeof t === 'string' && t.length > 0);
  const metaMentionsVariant = titles.some(t => VARIANT_MARKER.test(t));

  let best: IMalSyncEntry | null = null;
  let bestScore = -Infinity;
  for (const entry of usable) {
    const theirs = typeof entry.title === 'string' ? entry.title : '';
    let score = 0;
    for (const mine of titles) {
      const s = compareTwoStrings(mine.toLowerCase(), theirs.toLowerCase());
      if (s > score) score = s;
    }
    // Only penalise when the SERIES asked for is not itself a colour edition.
    if (!metaMentionsVariant && VARIANT_MARKER.test(theirs)) score -= VARIANT_PENALTY;
    // Ties go to the shorter title: '(Official Colored)' can only ever lengthen a base title, so
    // the shorter of two equal-scoring records is the base record.
    const better = score > bestScore || (score === bestScore && theirs.length < String(best?.title ?? '').length);
    if (better) {
      bestScore = score;
      best = entry;
    }
  }

  console.warn(
    `[manga-xref] MAL-Sync site ${siteLabel} holds ${usable.length} records for AniList manga id ` +
      `${meta.anilistId} (re-releases share malId AND aniId, so no id separates them) — picked ` +
      `"${best?.title}" by title over [${usable
        .filter(e => e !== best)
        .map(e => `"${e.title}"`)
        .join(', ')}]. This one selection is title-assisted; the id space is still exact.`
  );
  return best;
};

/** MAL-Sync client: one memoised, deduplicated GET per MAL id. */
export class MalSyncIndex {
  private readonly cache = new TtlCache<number, IMalSyncPayload | null>(v => (v ? TTL_HIT_MS : TTL_MISS_MS));

  constructor(
    private readonly client: AxiosInstance,
    private readonly baseUrl: string = MALSYNC_BASE
  ) {}

  /**
   * `null` means "MAL-Sync has no mapping" (a real 404 — verified live with malId 99999999) or the
   * request failed. Never throws: a bridge that throws is caught by the aggregator, but returning
   * null keeps the resolver's best-effort enrichment path simple.
   */
  lookup = async (malId: number): Promise<IMalSyncPayload | null> => {
    if (!Number.isFinite(malId) || malId <= 0) return null;
    return this.cache.get(malId, async () => {
      try {
        const { data, status } = await this.client.get(`${this.baseUrl}/mal/manga/${malId}`, {
          // 404 is MAL-Sync's NORMAL "no mapping" answer, not a transport fault. Letting axios
          // throw on it would turn an ordinary miss into a logged bridge failure.
          validateStatus: () => true,
        });
        if (status === 404) return null;
        if (status !== 200) {
          console.warn(
            `[manga-xref] MAL-Sync /mal/manga/${malId} answered HTTP ${status} — treating as "no mapping" ` +
              `for this call (upstream fault, not a provider fault)`
          );
          return null;
        }
        return (data ?? null) as IMalSyncPayload | null;
      } catch (err) {
        console.error(
          `[manga-xref] MAL-Sync /mal/manga/${malId} FAILED (degrading to no id bridge, title ` +
            `matching still runs): ${safeErrorString(err)}`
        );
        return null;
      }
    });
  };

  /** Every entry MAL-Sync lists for one site, in payload order. */
  entriesForSite = (payload: IMalSyncPayload | null, site: string): IMalSyncEntry[] => {
    const sites = payload?.Sites;
    if (!sites || typeof sites !== 'object') return [];
    // MAL-Sync spells its keys inconsistently across endpoints ('Mangadex' here), so match
    // case-insensitively rather than pinning a capitalisation that could drift.
    const key = Object.keys(sites).find(k => k.toLowerCase() === site.toLowerCase());
    if (key === undefined) return [];
    const bucket = sites[key];
    return bucket && typeof bucket === 'object' ? Object.values(bucket).filter(Boolean) : [];
  };

  clearCache = (): void => this.cache.clear();

  stats = () => ({ hits: this.cache.hits, misses: this.cache.misses });
}

// =============================================================================================
// MANGADEX AS A VERIFIER
// =============================================================================================

/** A MangaDex record, reduced to what the metadata layer uses. */
export interface IMangaDexRecord {
  /** v4 UUID — exactly what `MangaDex.fetchMangaInfo` consumes. */
  id: string;
  /** Primary title plus every alt title, deduplicated. The enrichment payload. */
  titles: string[];
  /** `attributes.links`, verbatim. `al`/`mal` are the ones this layer reads. */
  links: Record<string, string>;
  /** `links.mal` parsed, for cross-checking AniList's own `idMal`. */
  malId?: number;
  year?: number;
  originalLanguage?: string;
  status?: string;
  /** How the record was reached — recorded so a caller can tell a verified id from a guess. */
  matchedBy: 'malsync-then-links.al' | 'title-search-then-links.al';
}

const asTrimmed = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s;
};

/** Flatten a MangaDex record's `title` + `altTitles` into a deduplicated list. */
const mangaDexTitles = (attributes: any): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: unknown) => {
    const s = asTrimmed(v);
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  // `title` is a {lang: string} map with NO canonical language — live responses use 'ja-ro',
  // 'ko-ro' and 'en' as the primary within a single result set. Take all of them.
  const title = attributes?.title;
  if (title && typeof title === 'object') for (const v of Object.values(title)) push(v);
  const alts = attributes?.altTitles;
  if (Array.isArray(alts)) for (const alt of alts) if (alt && typeof alt === 'object') for (const v of Object.values(alt)) push(v);
  return out;
};

const toRecord = (raw: any, matchedBy: IMangaDexRecord['matchedBy']): IMangaDexRecord | null => {
  const id = asTrimmed(raw?.id);
  if (!id) return null;
  const a = raw?.attributes ?? {};
  const links: Record<string, string> = {};
  if (a.links && typeof a.links === 'object')
    for (const [k, v] of Object.entries(a.links)) if (typeof v === 'string') links[k] = v;
  const malId = Number(links.mal);
  return {
    id,
    titles: mangaDexTitles(a),
    links,
    ...(Number.isFinite(malId) && malId > 0 ? { malId } : {}),
    ...(typeof a.year === 'number' ? { year: a.year } : {}),
    ...(asTrimmed(a.originalLanguage) ? { originalLanguage: asTrimmed(a.originalLanguage)! } : {}),
    ...(asTrimmed(a.status) ? { status: asTrimmed(a.status)! } : {}),
    matchedBy,
  };
};

/**
 * Finds THE MangaDex record for an AniList manga id, by hard id only.
 *
 * ORDER, cheapest-and-strongest first:
 *   1. MAL-Sync names the Mangadex UUID candidates (1 request, and usually already cached because
 *      the MAL-Sync bridge wants the same payload). Verify ALL of them in ONE
 *      `GET /manga?ids[]=…` and keep the one whose `links.al` equals the AniList id. This path
 *      involves no title comparison whatsoever, and it is what separates "One Piece" from "One
 *      Piece (Official Colored)" — verified live, only the base record carries `al`.
 *   2. Fall back to `GET /manga?title=…` for up to two AniList titles and scan the results for
 *      `links.al`. The title is used only to BUILD A CANDIDATE SET; the match itself is still by
 *      id, which is why this still finds "Na Honjaman Level-Up" for "Solo Leveling".
 *
 * Worst case is 3 upstream requests per AniList id, memoised for hours and deduplicated across the
 * whole provider fan-out. Never throws.
 */
export class MangaDexXref {
  private readonly cache = new TtlCache<string, IMangaDexRecord | null>(v => (v ? TTL_HIT_MS : TTL_MISS_MS));

  constructor(
    private readonly client: AxiosInstance,
    private readonly malsync?: MalSyncIndex,
    private readonly baseUrl: string = MANGADEX_API
  ) {}

  resolve = async (meta: IMangaMeta): Promise<IMangaDexRecord | null> => {
    const anilistId = String(meta?.anilistId ?? '').trim();
    if (anilistId === '') return null;
    return this.cache.get(anilistId, async () => {
      try {
        const viaMalSync = await this.viaMalSync(meta, anilistId);
        if (viaMalSync) return viaMalSync;
        return await this.viaTitleSearch(meta, anilistId);
      } catch (err) {
        console.error(
          `[manga-xref] MangaDex cross-reference for AniList manga id ${anilistId} FAILED ` +
            `(degrading to no verified MangaDex record; title matching still runs): ${safeErrorString(err)}`
        );
        return null;
      }
    });
  };

  /** Step 1 — MAL-Sync proposes UUIDs, `links.al` disposes. Zero title comparison. */
  private viaMalSync = async (meta: IMangaMeta, anilistId: string): Promise<IMangaDexRecord | null> => {
    if (!this.malsync || !meta.malId) return null;
    const payload = await this.malsync.lookup(meta.malId);
    const ids = this.malsync
      .entriesForSite(payload, 'Mangadex')
      .map(identifierAsId)
      // A MangaDex id is a v4 UUID. Anything else in this field is not one, and sending it to
      // `ids[]` earns a 400 for the whole batch, taking the good candidates down with it.
      .filter((id): id is string => id !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
    if (ids.length === 0) return null;

    const { data, status } = await this.client.get(`${this.baseUrl}/manga`, {
      // NOTE THE BARE KEYS. MangaDex wants `?ids[]=x&ids[]=y`, but axios appends the `[]` ITSELF
      // for any array-valued param — so writing the key as `'ids[]'` emits `ids[][]=x` and
      // MangaDex answers 400 for the whole request. Caught live: every MangaDex call in this file
      // 400'd on the first run, which silently degraded the strongest bridge in the system into
      // the title-matching fallback while still LOOKING like it worked. Pinned by
      // test/manga-metadata-bridges.test.mjs ("array params are serialised as ids[]=, not ids[][]=").
      params: {
        ids: ids.slice(0, 100), // MangaDex caps ids[] at 100; we will never approach it
        limit: Math.min(ids.length, 100),
        contentRating: [...ALL_CONTENT_RATINGS],
      },
      validateStatus: () => true,
    });
    if (status !== 200) {
      console.warn(
        `[manga-xref] MangaDex /manga?ids[] answered HTTP ${status} while verifying ${ids.length} ` +
          `MAL-Sync candidate(s) for AniList manga id ${anilistId} — falling back to title search`
      );
      return null;
    }
    return this.pickByAnilistLink(data?.data, anilistId, 'malsync-then-links.al');
  };

  /** Step 2 — a title only builds the candidate set; `links.al` still decides. */
  private viaTitleSearch = async (meta: IMangaMeta, anilistId: string): Promise<IMangaDexRecord | null> => {
    const probes = meta.titles.filter(t => typeof t === 'string' && t.trim() !== '').slice(0, TITLE_PROBES);
    for (const title of probes) {
      const { data, status } = await this.client.get(`${this.baseUrl}/manga`, {
        // Bare `contentRating` key for the same reason as in viaMalSync — axios adds the `[]`.
        params: {
          title,
          limit: TITLE_PROBE_LIMIT,
          contentRating: [...ALL_CONTENT_RATINGS],
        },
        validateStatus: () => true,
      });
      if (status !== 200) {
        console.warn(
          `[manga-xref] MangaDex /manga?title="${title}" answered HTTP ${status} for AniList manga id ` +
            `${anilistId} — trying the next title, if any`
        );
        continue;
      }
      const hit = this.pickByAnilistLink(data?.data, anilistId, 'title-search-then-links.al');
      if (hit) return hit;
    }
    return null;
  };

  /**
   * The single comparison this whole class exists for: `attributes.links.al === <anilist id>`.
   * Note `links.al` is a STRING on the wire ('105778'), so both sides are normalised to string.
   */
  private pickByAnilistLink = (
    rows: unknown,
    anilistId: string,
    matchedBy: IMangaDexRecord['matchedBy']
  ): IMangaDexRecord | null => {
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
      const record = toRecord(row, matchedBy);
      if (record && String(record.links.al ?? '').trim() === anilistId) return record;
    }
    return null;
  };

  clearCache = (): void => this.cache.clear();

  stats = () => ({ hits: this.cache.hits, misses: this.cache.misses });
}
