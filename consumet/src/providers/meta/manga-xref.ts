import { AxiosInstance } from 'axios';

import { compareTwoStrings } from '../../utils/utils';
import { graphqlErrorsSummary, safeErrorString } from '../../utils/cf-solver';
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
/**
 * An upstream REFUSAL — 429, 5xx, 403, timeout, connection error — is NOT evidence of absence, so
 * it is barely cached: only enough to stop a single fan-out from firing the same doomed request
 * once per provider, and specifically to stop a 429 being answered with an immediate retry.
 *
 * THIS CONSTANT WAS DECLARED AND NEVER REFERENCED. Everything non-200 fell through to
 * TTL_MISS_MS = 10 minutes, so one rate-limited request cached "no mapping" for ten minutes.
 * See the section below for why the fix is a representation change and not just a TTL change.
 */
const TTL_ERROR_MS = 30 * 1000;

/**
 * BOUNDS ON AN UPSTREAM-SUPPLIED `Retry-After`.
 *
 * TTL_ERROR_MS above is this layer's own guess. When upstream states a back-off explicitly we
 * should prefer its number — it is the only party that knows when its own limiter resets — but a
 * header is attacker- and bug-supplied input and RFC 9110 §10.2.3 permits values this layer must
 * not obey literally. Both bounds exist for a stated reason:
 *
 *   * FLOOR (1s). `Retry-After: 0`, a NEGATIVE delta, and an HTTP-date already in the past are all
 *     things real servers send (a clock skew of a few seconds is enough on its own). Each of those
 *     computes to "retry now", and retrying a 429 immediately is the single response guaranteed to
 *     make a rate limit worse. One second is the smallest gap that is still a gap; concurrent
 *     callers inside it are already collapsed by the in-flight map, not by the TTL.
 *   * CAP (5 min). `Retry-After: 86400` is legal and a hostile or misconfigured upstream can send
 *     anything. The cap is deliberately set BELOW TTL_MISS_MS (10 min): a refusal must never be
 *     cached longer than a genuine, verified absence, because that would make "we could not find
 *     out" stickier than "we looked and it is not there" — an exact inversion of this file's point.
 *
 * An absent, empty, or unparseable header is NOT clamped to anything; it falls through to
 * TTL_ERROR_MS, because "upstream said nothing" and "upstream said zero" are different statements.
 */
const RETRY_AFTER_MIN_MS = 1000;
const RETRY_AFTER_MAX_MS = 5 * 60 * 1000;

/** Entries kept per cache. Small: one entry per series actually requested in the last few hours. */
const CACHE_MAX = 500;

// =============================================================================================
// "NO DATA" IS TWO DIFFERENT ANSWERS AND THEY MUST NOT SHARE A REPRESENTATION
//
// THE BUG THIS SECTION EXISTS TO KILL. Every lookup in this file degrades to a falsy value on
// failure — `null` for MAL-Sync and MangaDex, `[]` for the alias resolver. That same falsy value
// is ALSO the legitimate answer "upstream looked and there is genuinely no mapping". Collapsing
// the two costs twice:
//
//   1. THE CACHE POISONS ITSELF. A caller cannot tell them apart, so neither could the TTL
//      function, so a 429 used to be cached for TTL_MISS_MS = 10 minutes as though MAL-Sync had
//      asserted "no such series". One rate-limited request became ten minutes of a confidently
//      wrong answer, on a layer whose entire purpose is to stop confidently wrong answers.
//   2. THE CALLER CANNOT DEGRADE HONESTLY. "MAL-Sync says there is no MangaHere record" and
//      "MAL-Sync refused to answer" call for different behaviour upstream of here — the first is
//      a fact worth remembering, the second is a reason to keep the weaker path's label honest.
//      Shortening the TTL alone fixes (1) and leaves (2) exactly as broken.
//
// This is the same shape as the fail-open providers deleted in Phase 3: HTTP 200 with an empty
// array, so every health check called them healthy. The fix, here and there, is that an upstream
// refusal must be REPRESENTABLE, not merely short-lived.
//
// So every cached answer is an {@link IXrefResult}: the degraded value the legacy API still
// returns, plus a `fault` that is null iff upstream actually answered. `*Result()` methods expose
// it; the pre-existing methods keep their exact old signatures for the bridges in
// ./manga-metadata.ts and the alias path in ../manga/mangakakalot.ts.
// =============================================================================================

/**
 * Why a lookup produced no data. NONE of these is evidence of absence — that is the whole point of
 * separating them from a real 404 / real empty result.
 */
export type XrefFaultKind =
  /** HTTP 429, or an upstream that signals throttling in-band (AniList: HTTP 200 + errors[]). */
  | 'rate-limited'
  /** HTTP 5xx — upstream is broken, and says so. */
  | 'server-error'
  /** Any other non-200 that is not the documented "no mapping" answer (403 Cloudflare, 400, …). */
  | 'unexpected-status'
  /** The request threw: DNS, connect refused, TLS, timeout, abort. Nothing was ever answered. */
  | 'transport';

/** One upstream refusal, in enough detail for a caller to log or branch on without re-deriving it. */
export interface IXrefFault {
  kind: XrefFaultKind;
  /** Which upstream refused, e.g. 'malsync', 'mangadex', 'anilist-alias'. */
  source: string;
  /** The HTTP status, when there was one at all (absent for `transport`). */
  status?: number;
  /** Already-sanitised human-readable detail. Safe to log. */
  detail: string;
  /**
   * The back-off upstream ASKED FOR, in ms, already parsed and clamped to
   * [RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS].
   *
   * ABSENT means upstream sent no usable `Retry-After` — NOT that it asked for zero. The cache
   * falls back to TTL_ERROR_MS in that case, so the distinction is load-bearing and this field must
   * stay optional rather than defaulted.
   */
  retryAfterMs?: number;
}

/**
 * A lookup answer plus whether it is a FACT ABOUT THE DATA or an upstream refusal.
 *
 * `fault === null` means upstream answered: `value` is either the real record or a real "not
 * there". `fault !== null` means `value` is a degraded placeholder and means nothing.
 */
export interface IXrefResult<T> {
  value: T;
  fault: IXrefFault | null;
}

/** Upstream answered. `value` is a fact — a record, or a genuine absence. */
export const xrefAnswer = <T>(value: T): IXrefResult<T> => ({ value, fault: null });

/** Upstream refused. `value` is only the degraded placeholder the legacy API returns. */
export const xrefFault = <T>(value: T, fault: IXrefFault): IXrefResult<T> => ({ value, fault });

/** Clamp a computed back-off into the band argued for above. Infinity clamps to the cap. */
const clampRetryAfterMs = (ms: number): number =>
  Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, Math.round(ms)));

/**
 * Parse one `Retry-After` value into a clamped millisecond back-off, or null when it says nothing.
 *
 * RFC 9110 §10.2.3 gives the header TWO legal forms and both are in live use:
 *   * `delta-seconds` — a non-negative integer, e.g. `Retry-After: 120`.
 *   * `HTTP-date` — an IMF-fixdate, e.g. `Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`.
 *
 * `Date.parse` IS FAR TOO LENIENT TO BE THE FALLBACK BRANCH, and both guards below were put in by
 * a test that caught them:
 *   * ORDER. `Date.parse('120')` is the YEAR 120 in V8, not NaN. Probing the date form first would
 *     read `Retry-After: 120` as a moment ~1,900 years in the past and clamp it to the floor —
 *     turning a two-minute back-off into a one-second one. Digits are matched first, always.
 *   * THE LETTER GUARD. `Date.parse('12.5')` also succeeds (some day in the current year), so an
 *     ILLEGAL numeric-ish value — `12.5`, `-5`, `1,5` — would likewise floor rather than fall back.
 *     Every legal HTTP-date form (IMF-fixdate, RFC 850, asctime) names a weekday and a month, so a
 *     value with no ASCII letter in it cannot be one and is rejected outright.
 *
 * Returns null (⇒ caller falls back to TTL_ERROR_MS) for an absent, empty or unparseable value —
 * including the `Retry-After: Fri, 31 Dec 1999 …` and `Retry-After: soon` shapes a broken upstream
 * emits. A parseable but absurd value is CLAMPED rather than rejected: upstream did state
 * something, so honour the direction of it while refusing to be wedged by the magnitude.
 */
export const parseRetryAfterMs = (raw: unknown, now: number = Date.now()): number | null => {
  // A fake adapter (and some HTTP stacks) hand back a number rather than the wire string.
  if (typeof raw === 'number') return Number.isFinite(raw) ? clampRetryAfterMs(raw * 1000) : null;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '') return null;
  // delta-seconds. `Number` on an all-digit string is never NaN; an absurdly long one becomes
  // Infinity, which clampRetryAfterMs takes to the cap — the desired outcome, not an error.
  if (/^\d+$/.test(value)) return clampRetryAfterMs(Number(value) * 1000);
  // No weekday and no month name ⇒ not an HTTP-date in any of its three forms. Falling back to
  // TTL_ERROR_MS is strictly safer than letting Date.parse invent a timestamp from `12.5`.
  if (!/[a-z]/i.test(value)) return null;
  const when = Date.parse(value);
  // A past date is legal-ish and common under clock skew; it clamps to the floor rather than
  // being discarded, so "you may retry" is honoured without becoming "retry instantly".
  return Number.isNaN(when) ? null : clampRetryAfterMs(when - now);
};

/**
 * Pull `Retry-After` out of an axios response `headers`, case-insensitively.
 *
 * Axios hands back an `AxiosHeaders` instance on a real request (which has `.get()` AND own
 * lowercased enumerable properties) but a plain object from a fake adapter, which may spell the
 * key with any casing. Both are handled; neither is assumed.
 */
export const retryAfterFromHeaders = (headers: unknown, now?: number): number | null => {
  if (!headers || typeof headers !== 'object') return null;
  const bag = headers as Record<string, unknown> & { get?: (name: string) => unknown };
  let raw: unknown;
  if (typeof bag.get === 'function') {
    try {
      raw = bag.get('retry-after');
    } catch {
      raw = undefined;
    }
  }
  if (raw === undefined || raw === null) {
    const key = Object.keys(bag).find(k => k.toLowerCase() === 'retry-after');
    if (key !== undefined) raw = bag[key];
  }
  // A repeated header arrives as an array; the first value is the one to obey.
  if (Array.isArray(raw)) raw = raw[0];
  return parseRetryAfterMs(raw, now);
};

/**
 * Classify a non-200 status. The caller has already peeled off whatever status means "no mapping"
 * for that endpoint (404 on MAL-Sync), so everything reaching here is a refusal by definition.
 *
 * Pass the response `headers` so an upstream-stated `Retry-After` sets the cache TTL instead of the
 * flat TTL_ERROR_MS guess. Omitting them is safe and simply keeps the old behaviour.
 *
 * HONESTY NOTE ON MAL-SYNC SPECIFICALLY: nothing in this repo has ever observed MAL-Sync under
 * throttle. Its 429 status code, and whether it sends `Retry-After` at all, are UNCONFIRMED — this
 * is implemented against RFC 9110 and exercised by a scripted adapter, not against a live refusal.
 */
export const faultForStatus = (
  status: number,
  source: string,
  detail?: string,
  headers?: unknown
): IXrefFault => {
  const retryAfterMs = retryAfterFromHeaders(headers);
  return {
    kind: status === 429 ? 'rate-limited' : status >= 500 ? 'server-error' : 'unexpected-status',
    source,
    status,
    detail: detail ?? `HTTP ${status}`,
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
  };
};

/** Classify a thrown request. Timeouts and connection failures are indistinguishable to a caller. */
export const faultForError = (err: unknown, source: string): IXrefFault => ({
  kind: 'transport',
  source,
  detail: safeErrorString(err),
});

/** One line describing a fault, for logs that must not assert "no mapping". */
const faultLine = (fault: IXrefFault): string =>
  `${fault.kind} (${fault.detail})` +
  (fault.retryAfterMs === undefined ? '' : `, upstream asked to retry after ${fault.retryAfterMs}ms`);

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
 *
 * THE TTL IS CHOSEN FROM THE OUTCOME, NOT FROM THE VALUE. That distinction is the fix for the
 * cache-poisoning bug documented above: `isHit` only ever sees a value upstream actually vouched
 * for, because a faulted result takes the error TTL before `isHit` is consulted at all. That error
 * TTL is `fault.retryAfterMs` when upstream stated one and TTL_ERROR_MS otherwise; 30 seconds is
 * deliberately kept as the fallback rather than dropped to zero — retrying a 429 immediately is the
 * one response guaranteed to make a rate limit worse, and the window is short enough that a caller
 * that waits out one fan-out gets a real answer.
 */
class TtlResultCache<K, V> {
  private readonly values = new Map<K, { result: IXrefResult<V>; expiresAt: number }>();
  private readonly inFlight = new Map<K, Promise<IXrefResult<V>>>();

  /** Diagnostics only — `describe()` on the layer reports these. */
  hits = 0;
  misses = 0;
  /** Answers stored as an upstream REFUSAL rather than as a fact. A rising count is an outage. */
  faults = 0;

  /** Given a value upstream vouched for, is it a real record (TTL_HIT_MS) or a real absence? */
  constructor(private readonly isHit: (value: V) => boolean) {}

  /**
   * A faulted result is held for exactly as long as upstream ASKED to be left alone, and only falls
   * back to this layer's TTL_ERROR_MS guess when upstream asked for nothing. `retryAfterMs` is
   * already clamped at parse time, so no bound is re-applied here — one place owns the policy.
   */
  private ttlFor = (result: IXrefResult<V>): number =>
    result.fault
      ? result.fault.retryAfterMs ?? TTL_ERROR_MS
      : this.isHit(result.value)
        ? TTL_HIT_MS
        : TTL_MISS_MS;

  get = async (key: K, load: () => Promise<IXrefResult<V>>): Promise<IXrefResult<V>> => {
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.hits++;
      return cached.result;
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      this.hits++;
      return pending;
    }
    this.misses++;
    const promise = load()
      .then(result => {
        if (result.fault) this.faults++;
        // Map preserves insertion order, so the first key is the oldest — a one-line LRU-ish bound.
        if (this.values.size >= CACHE_MAX) {
          const oldest = this.values.keys().next();
          if (!oldest.done) this.values.delete(oldest.value);
        }
        this.values.set(key, { result, expiresAt: Date.now() + this.ttlFor(result) });
        return result;
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
  private readonly cache = new TtlResultCache<number, IMalSyncPayload | null>(v => v !== null);

  constructor(
    private readonly client: AxiosInstance,
    private readonly baseUrl: string = MALSYNC_BASE
  ) {}

  /**
   * The full answer: the payload (or null) PLUS whether MAL-Sync actually answered.
   *
   * `{ value: null, fault: null }` is "MAL-Sync has no mapping" — a real 404, verified live with
   * malId 99999999, and a durable fact worth caching for TTL_MISS_MS. `{ value: null, fault: {…} }`
   * is "MAL-Sync refused", which is not a fact about the series at all and is cached for
   * TTL_ERROR_MS so the next fan-out can get a real answer. Never throws.
   */
  lookupResult = async (malId: number): Promise<IXrefResult<IMalSyncPayload | null>> => {
    if (!Number.isFinite(malId) || malId <= 0) return xrefAnswer(null);
    return this.cache.get(malId, async () => {
      try {
        const { data, status, headers } = await this.client.get(`${this.baseUrl}/mal/manga/${malId}`, {
          // 404 is MAL-Sync's NORMAL "no mapping" answer, not a transport fault. Letting axios
          // throw on it would turn an ordinary miss into a logged bridge failure.
          validateStatus: () => true,
        });
        if (status === 404) return xrefAnswer(null);
        if (status !== 200) {
          const fault = faultForStatus(status, 'malsync', undefined, headers);
          // NOT "treating as no mapping" — that was the conflation. We do not know whether a
          // mapping exists; we know only that MAL-Sync would not tell us.
          console.warn(
            `[manga-xref] MAL-Sync /mal/manga/${malId} answered HTTP ${status} — UNKNOWN whether a ` +
              `mapping exists (${faultLine(fault)}); the id bridge is skipped for now and this is ` +
              `cached for ${fault.retryAfterMs ?? TTL_ERROR_MS}ms only, NOT as a "no mapping" result`
          );
          return xrefFault<IMalSyncPayload | null>(null, fault);
        }
        return xrefAnswer((data ?? null) as IMalSyncPayload | null);
      } catch (err) {
        const fault = faultForError(err, 'malsync');
        console.error(
          `[manga-xref] MAL-Sync /mal/manga/${malId} FAILED — UNKNOWN whether a mapping exists ` +
            `(${faultLine(fault)}); degrading to no id bridge, title matching still runs`
        );
        return xrefFault<IMalSyncPayload | null>(null, fault);
      }
    });
  };

  /**
   * Legacy shape, unchanged for the bridges in ./manga-metadata.ts: the payload, or null for
   * EITHER "no mapping" or "upstream refused". Callers that need to tell those apart — and the
   * confidence labelling arguably should — must use {@link lookupResult}.
   */
  lookup = async (malId: number): Promise<IMalSyncPayload | null> => (await this.lookupResult(malId)).value;

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

  stats = () => ({ hits: this.cache.hits, misses: this.cache.misses, faults: this.cache.faults });
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
  private readonly cache = new TtlResultCache<string, IMangaDexRecord | null>(v => v !== null);

  constructor(
    private readonly client: AxiosInstance,
    private readonly malsync?: MalSyncIndex,
    private readonly baseUrl: string = MANGADEX_API
  ) {}

  /**
   * The full answer: the record (or null) PLUS whether every upstream on the path actually
   * answered.
   *
   * A FAULT ANYWHERE ON THE PATH POISONS THE "NOT FOUND". If MAL-Sync 429s, its candidate UUIDs
   * never reach the batch verifier, so a subsequent empty title search is not evidence that no
   * MangaDex record exists — the strongest path was simply never walked. So the fault propagates
   * and the null is cached for TTL_ERROR_MS, not TTL_MISS_MS. A found record clears it: an answer
   * is an answer however it was reached.
   */
  resolveResult = async (meta: IMangaMeta): Promise<IXrefResult<IMangaDexRecord | null>> => {
    const anilistId = String(meta?.anilistId ?? '').trim();
    if (anilistId === '') return xrefAnswer(null);
    return this.cache.get(anilistId, async () => {
      // The FIRST fault on the path is kept: it is the earliest cause, and the later steps are
      // only running because of it.
      let fault: IXrefFault | null = null;
      try {
        const viaMalSync = await this.viaMalSync(meta, anilistId);
        if (viaMalSync.value) return xrefAnswer(viaMalSync.value);
        fault = viaMalSync.fault;

        const viaTitle = await this.viaTitleSearch(meta, anilistId);
        if (viaTitle.value) return xrefAnswer(viaTitle.value);
        fault = fault ?? viaTitle.fault;
      } catch (err) {
        fault = faultForError(err, 'mangadex');
        console.error(
          `[manga-xref] MangaDex cross-reference for AniList manga id ${anilistId} FAILED — UNKNOWN ` +
            `whether a MangaDex record exists (${faultLine(fault)}); degrading to no verified record, ` +
            `title matching still runs`
        );
      }
      return fault ? xrefFault<IMangaDexRecord | null>(null, fault) : xrefAnswer(null);
    });
  };

  /**
   * Legacy shape, unchanged for `VerifiedMangaMetadataResolver`: the record, or null for EITHER
   * "no MangaDex record carries this AniList id" or "an upstream on the path refused". Use
   * {@link resolveResult} to tell those apart.
   */
  resolve = async (meta: IMangaMeta): Promise<IMangaDexRecord | null> => (await this.resolveResult(meta)).value;

  /** Step 1 — MAL-Sync proposes UUIDs, `links.al` disposes. Zero title comparison. */
  private viaMalSync = async (
    meta: IMangaMeta,
    anilistId: string
  ): Promise<IXrefResult<IMangaDexRecord | null>> => {
    if (!this.malsync || !meta.malId) return xrefAnswer(null);
    const malsync = await this.malsync.lookupResult(meta.malId);
    // MAL-Sync refusing is not "MAL-Sync has no Mangadex candidates". Carry it forward so a later
    // empty title search cannot be mistaken for a verified absence.
    if (malsync.fault) return xrefFault<IMangaDexRecord | null>(null, malsync.fault);
    const ids = this.malsync
      .entriesForSite(malsync.value, 'Mangadex')
      .map(identifierAsId)
      // A MangaDex id is a v4 UUID. Anything else in this field is not one, and sending it to
      // `ids[]` earns a 400 for the whole batch, taking the good candidates down with it.
      .filter((id): id is string => id !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
    if (ids.length === 0) return xrefAnswer(null);

    const { data, status, headers } = await this.client.get(`${this.baseUrl}/manga`, {
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
      const fault = faultForStatus(status, 'mangadex', undefined, headers);
      console.warn(
        `[manga-xref] MangaDex /manga?ids[] answered HTTP ${status} while verifying ${ids.length} ` +
          `MAL-Sync candidate(s) for AniList manga id ${anilistId} (${faultLine(fault)}) — falling back ` +
          `to title search; these candidates remain UNVERIFIED, not disproved`
      );
      return xrefFault<IMangaDexRecord | null>(null, fault);
    }
    return xrefAnswer(this.pickByAnilistLink(data?.data, anilistId, 'malsync-then-links.al'));
  };

  /** Step 2 — a title only builds the candidate set; `links.al` still decides. */
  private viaTitleSearch = async (
    meta: IMangaMeta,
    anilistId: string
  ): Promise<IXrefResult<IMangaDexRecord | null>> => {
    const probes = meta.titles.filter(t => typeof t === 'string' && t.trim() !== '').slice(0, TITLE_PROBES);
    let fault: IXrefFault | null = null;
    for (const title of probes) {
      const { data, status, headers } = await this.client.get(`${this.baseUrl}/manga`, {
        // Bare `contentRating` key for the same reason as in viaMalSync — axios adds the `[]`.
        params: {
          title,
          limit: TITLE_PROBE_LIMIT,
          contentRating: [...ALL_CONTENT_RATINGS],
        },
        validateStatus: () => true,
      });
      if (status !== 200) {
        const probeFault = faultForStatus(status, 'mangadex', undefined, headers);
        fault = fault ?? probeFault;
        console.warn(
          `[manga-xref] MangaDex /manga?title="${title}" answered HTTP ${status} for AniList manga id ` +
            `${anilistId} (${faultLine(probeFault)}) — trying the next title, if any; this probe proves ` +
            `NOTHING about whether the record exists`
        );
        continue;
      }
      const hit = this.pickByAnilistLink(data?.data, anilistId, 'title-search-then-links.al');
      if (hit) return xrefAnswer(hit);
    }
    return fault ? xrefFault<IMangaDexRecord | null>(null, fault) : xrefAnswer(null);
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

  stats = () => ({ hits: this.cache.hits, misses: this.cache.misses, faults: this.cache.faults });
}

// =============================================================================================
// ALIAS RESOLUTION — free text in, PROVIDER IDS out.
//
// WHY THIS EXISTS. Everything above answers "given an AniList id, which record is this on provider
// X?". That is the aggregator's question. It is NOT the question a provider whose own search is
// unusable has to answer, which is the inverse: "given the words a human typed, which id on MY site
// is that?".
//
// THE CONCRETE FAILURE. MangaKakalot/MangaNato's search endpoints are both behind a Cloudflare
// managed challenge (see src/providers/manga/mangakakalot.ts for the full probe log), so that
// provider ranks queries against a slug index built from the sitemap. A slug encodes exactly ONE
// title, so `demon slayer` cannot reach `kimetsu-no-yaiba`. Measured on the live index (93,735
// slugs, 2026-08-14) the old behaviour was worse than a miss — `demon slayer` returned NINE
// confident results, every one of them a doujinshi or a colour re-release, and the real series was
// absent:
//
//   demon-slayer-tanjiro-kanao-doujinshi, demon-slayer-s-quest,
//   demon-slayer-kimetsu-no-yaiba-colored, demon-slayer-kimetsu-academy, …
//
// AniList already knows `Kimetsu no Yaiba` is `Demon Slayer: Kimetsu no Yaiba`, and MAL-Sync
// already names the exact MangaNato slug for its MAL id. Both bridges are committed machinery
// sitting in this file. This class points them at the query string instead of at an id.
//
// THIS IS A CROSS-REFERENCE, NOT A SEARCH ENGINE. It cannot find a series AniList does not carry,
// and it does not rank the site's catalogue. It converts one query into a small set of
// *externally-attested* identities, each of which the caller must still confirm exists on its own
// site. Attestation without confirmation would be a new way to return confident nonsense, which is
// the exact failure it is here to remove.
// =============================================================================================

const ANILIST_API = 'https://graphql.anilist.co';

/** AniList candidates pulled per query. Beyond ~8 the tail is unrelated series. */
const ALIAS_CANDIDATES = 8;

/**
 * Minimum query↔title similarity for a candidate to be believed.
 *
 * Calibrated against the live probe, not guessed. For `solo leveling` the third AniList hit is
 * "The Privilege of the Second Life is Power Leveling" at 0.647, which is a coincidental bigram
 * overlap and must not become a search result; the two real hits score 1.000. 0.7 sits in that gap.
 */
const ALIAS_MIN_SIMILARITY = 0.7;

/** One resolved external identity for a free-text query. */
export interface IMangaAliasCandidate {
  anilistId: number;
  malId?: number;
  /** AniList `popularity`. Kept because it is the tiebreaker — see {@link MangaAliasResolver.resolve}. */
  popularity: number;
  /** romaji, english, native, then every synonym — deduplicated, AniList order preserved. */
  titles: string[];
  /** 0..1 similarity of the query to this candidate's best-matching title. */
  similarity: number;
}

/**
 * Query/title normalisation for comparison only. Deliberately lossy: punctuation and case carry no
 * signal across romanisations, and `compareTwoStrings` already strips whitespace itself.
 */
const normalizeTitle = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The forms of a title worth comparing against.
 *
 * THE SUBTITLE SPLIT IS THE WHOLE TRICK, and it is not cosmetic. English manga titles are
 * overwhelmingly `<localised name>: <original romaji>` — "Demon Slayer: Kimetsu no Yaiba",
 * "Attack on Titan: No Regrets". Comparing `demon slayer` against the FULL string scores it BELOW
 * "Demon Slayer Mother" (an unrelated series, and AniList's own top hit for that query), because
 * the trailing romaji dilutes the bigram overlap. Comparing against the part before the colon
 * scores an exact 1.000 and puts the right series first. Verified live for `demon slayer`,
 * `shingeki no kyojin`, `attack on titan`, `solo leveling` and `kimetsu no yaiba`.
 */
const titleVariants = (title: string): string[] => {
  const variants = [title];
  const head = title.split(/[:–—]/)[0];
  if (head && head.trim() !== title.trim()) variants.push(head);
  return variants;
};

/** Best similarity of `query` against any variant of any of `titles`. */
export const scoreAliasTitles = (query: string, titles: readonly string[]): number => {
  const wanted = normalizeTitle(query);
  if (!wanted) return 0;
  let best = 0;
  for (const title of titles)
    for (const variant of titleVariants(title)) {
      const candidate = normalizeTitle(variant);
      if (!candidate) continue;
      const score = candidate === wanted ? 1 : compareTwoStrings(wanted, candidate);
      if (score > best) best = score;
    }
  return best;
};

interface AniListAliasMedia {
  id?: number;
  idMal?: number | null;
  popularity?: number | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  synonyms?: (string | null)[] | null;
}

const ALIAS_QUERY = `query ($search: String, $perPage: Int) {
  Page(perPage: $perPage) {
    media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
      id
      idMal
      popularity
      title { romaji english native }
      synonyms
    }
  }
}`;

/**
 * Free-text query → externally-attested series identities → exact provider ids.
 *
 * Two independent outputs, and a caller should use both:
 *   * {@link resolve} returns AniList candidates carrying every title and synonym AniList knows.
 *     Slugifying those titles is enough on its own to cross a romanisation gap, and it needs no
 *     MAL-Sync coverage at all.
 *   * {@link providerIdFor} additionally asks MAL-Sync for the provider's OWN identifier for that
 *     series. This is the strong path — a hard id with no string matching anywhere in it. Verified
 *     live 2026-08-14: `demon slayer` → AniList 87216 (idMal 96792) → MAL-Sync `Sites.MangaNato` →
 *     the single entry `kimetsu-no-yaiba`, carrying `aniId: 87216` in agreement.
 *
 * Never throws. An upstream fault is logged and degrades to "no aliases", which leaves the caller
 * exactly where it was before this class existed.
 */
export class MangaAliasResolver {
  /**
   * NOTE THE `isHit` PREDICATE, AND WHY IT IS ONLY SAFE NOW. An empty array is a LEGITIMATE result
   * here — AniList genuinely carries no manga matching the query above ALIAS_MIN_SIMILARITY — and
   * it used to double as the failure value, so `v.length ? … : TTL_MISS_MS` cached a 429 as
   * "AniList has never heard of this series" for ten minutes. `TtlResultCache` only consults this
   * predicate for a value AniList actually vouched for; a refusal takes TTL_ERROR_MS instead.
   */
  private readonly cache = new TtlResultCache<string, IMangaAliasCandidate[]>(v => v.length > 0);

  constructor(
    private readonly client: AxiosInstance,
    /** Optional. Without it {@link providerIdFor} always returns null and only titles are offered. */
    private readonly malsync?: MalSyncIndex,
    private readonly anilistUrl: string = ANILIST_API
  ) {}

  /**
   * Candidates for `query`, best first.
   *
   * ORDERING, and the honest account of it: the primary key is title similarity and the tiebreak is
   * AniList `popularity`. The tiebreak is load-bearing rather than decorative, because the subtitle
   * split above drives whole families of spin-offs to an identical 1.000 — for `demon slayer` the
   * main series, "Kimetsu Academy", "The Flower of Happiness" and "One-Winged Butterfly" all score
   * exactly 1.000 and ONLY popularity separates them (208,719 vs 2,667 / 2,448 / 2,026).
   *
   * That makes this a popularity prior, and priors can be wrong: someone who genuinely wants an
   * obscure spin-off whose localised name is a prefix of a famous one gets the famous one first. It
   * is still the right default — the spin-offs stay in the list, just below — but it is a ranking
   * heuristic and must not be read as an identification.
   */
  resolveResult = async (query: string): Promise<IXrefResult<IMangaAliasCandidate[]>> => {
    const key = normalizeTitle(query);
    if (!key) return xrefAnswer([]);
    return this.cache.get(key, async () => {
      let payload: any;
      // AniList states its throttle window IN BAND (HTTP 200 + errors[]) as well as out of band,
      // so the header is captured on the 200 path too — see the errors[] branch below.
      let responseHeaders: unknown;
      try {
        const { data, status, headers } = await this.client.post(
          this.anilistUrl,
          { query: ALIAS_QUERY, variables: { search: query, perPage: ALIAS_CANDIDATES } },
          {
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            validateStatus: () => true,
          }
        );
        responseHeaders = headers;
        if (status !== 200) {
          const fault = faultForStatus(status, 'anilist-alias', undefined, headers);
          console.warn(
            `[manga-xref] AniList alias search for "${query}" answered HTTP ${status} — no aliases for ` +
              `this query (${faultLine(fault)}; an upstream fault, NOT "the series does not exist")`
          );
          return xrefFault<IMangaAliasCandidate[]>([], fault);
        }
        payload = data;
      } catch (err) {
        const fault = faultForError(err, 'anilist-alias');
        console.error(
          `[manga-xref] AniList alias search for "${query}" FAILED (no aliases; the caller's own ` +
            `matching still runs): ${faultLine(fault)}`
        );
        return xrefFault<IMangaAliasCandidate[]>([], fault);
      }

      // AniList signals rate limiting as HTTP 200 with a populated errors[] and null data. Reading
      // that as "no such series" is precisely the silent degradation this layer exists to stop —
      // and caching it as one for TTL_MISS_MS was the version of that mistake this cache used to
      // make, because [] was both the failure value and a legitimate answer.
      const errors = graphqlErrorsSummary(payload);
      if (errors) {
        // AniList sends `Retry-After` alongside its in-band throttle error, so the 200 path gets the
        // same treatment as a 429: obey the stated window, fall back to TTL_ERROR_MS if it is absent.
        const retryAfterMs = retryAfterFromHeaders(responseHeaders);
        const fault: IXrefFault = {
          // AniList's throttle arrives as an in-band error, so an explicit rate-limit mention is
          // the only way to classify it; anything else is an unattributed upstream fault.
          kind: /rate|too many requests|429|throttl/i.test(errors) ? 'rate-limited' : 'unexpected-status',
          source: 'anilist-alias',
          status: 200,
          detail: `HTTP 200 with GraphQL errors: ${errors}`,
          ...(retryAfterMs !== null ? { retryAfterMs } : {}),
        };
        console.error(
          `[manga-xref] AniList alias search for "${query}" returned HTTP 200 WITH errors — treating as ` +
            `an upstream fault, NOT as "no matches": ${errors}`
        );
        return xrefFault<IMangaAliasCandidate[]>([], fault);
      }

      const media: AniListAliasMedia[] = payload?.data?.Page?.media ?? [];
      if (!Array.isArray(media)) return xrefAnswer([]);

      const candidates: IMangaAliasCandidate[] = [];
      for (const entry of media) {
        const anilistId = Number(entry?.id);
        if (!Number.isFinite(anilistId) || anilistId <= 0) continue;

        const titles: string[] = [];
        const seen = new Set<string>();
        const synonyms = Array.isArray(entry?.synonyms) ? entry.synonyms : [];
        for (const raw of [entry?.title?.romaji, entry?.title?.english, entry?.title?.native, ...synonyms]) {
          const title = asTrimmed(raw);
          if (!title) continue;
          const dedupe = title.toLowerCase();
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          titles.push(title);
        }
        if (!titles.length) continue;

        const similarity = scoreAliasTitles(query, titles);
        if (similarity < ALIAS_MIN_SIMILARITY) continue;

        const malId = Number(entry?.idMal);
        const popularity = Number(entry?.popularity);
        candidates.push({
          anilistId,
          ...(Number.isFinite(malId) && malId > 0 ? { malId } : {}),
          popularity: Number.isFinite(popularity) ? popularity : 0,
          titles,
          similarity,
        });
      }

      return xrefAnswer(candidates.sort((a, b) => b.similarity - a.similarity || b.popularity - a.popularity));
    });
  };

  /**
   * Legacy shape, unchanged for `MangaKakalot`'s alias bridge: candidates, or `[]` for EITHER
   * "AniList carries nothing close enough" or "AniList refused". Use {@link resolveResult} to tell
   * those apart — an empty array is the one place in this file where the degraded value is also a
   * perfectly ordinary answer.
   */
  resolve = async (query: string): Promise<IMangaAliasCandidate[]> => (await this.resolveResult(query)).value;

  /**
   * The provider's own identifier for `candidate`, via MAL-Sync, or null.
   *
   * Costs nothing for a provider MAL-Sync does not cover, or for a candidate AniList gave no MAL id
   * for — both return null before any request, the same invariant the id bridges above keep.
   */
  providerIdFor = async (candidate: IMangaAliasCandidate, providerName: string): Promise<string | null> => {
    if (!this.malsync || !candidate?.malId) return null;
    const binding = MALSYNC_SITE_BINDINGS.find(b => b.provider.toLowerCase() === providerName.toLowerCase());
    if (!binding) return null;

    try {
      const malsync = await this.malsync.lookupResult(candidate.malId);
      if (malsync.fault) {
        console.warn(
          `[manga-xref] MAL-Sync alias bridge for AniList manga id ${candidate.anilistId} → ` +
            `${providerName}: UNKNOWN whether ${binding.site} lists this series ` +
            `(${faultLine(malsync.fault)}) — falling back to slugified titles`
        );
        return null;
      }
      const entries = this.malsync.entriesForSite(malsync.value, binding.site);
      if (!entries.length) return null;
      // pickSiteEntry drops entries whose `aniId` disagrees with the AniList id — a free hard check
      // that the MAL id we followed really does lead back to the series AniList named.
      const meta: IMangaMeta = {
        anilistId: String(candidate.anilistId),
        titles: candidate.titles,
        ...(candidate.malId ? { malId: candidate.malId } : {}),
      };
      const entry = pickSiteEntry(entries, meta, binding.site);
      return entry ? binding.toProviderId(entry) : null;
    } catch (err) {
      console.error(
        `[manga-xref] MAL-Sync alias bridge for AniList manga id ${candidate.anilistId} → ${providerName} ` +
          `FAILED (falling back to slugified titles): ${safeErrorString(err)}`
      );
      return null;
    }
  };

  clearCache = (): void => this.cache.clear();

  stats = () => ({ hits: this.cache.hits, misses: this.cache.misses, faults: this.cache.faults });
}
