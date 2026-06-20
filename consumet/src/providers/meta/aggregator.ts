import axios, { AxiosInstance } from 'axios';

import { AnimeParser, IAnimeEpisode, IAnimeInfo, ISource } from '../../models';
import { compareTwoStrings } from '../../utils/utils';
import AniNeko from '../anime/anineko';
import AnimeNoSub from '../anime/animenosub';
import AnikotoTV from '../anime/anikototv';
import ReAnime from '../anime/reanime';
import Gogoanime from '../anime/gogoanime';
import AnimeUnity from '../anime/animeunity';

const ANILIST_GRAPHQL = 'https://graphql.anilist.co';

export interface IAggregatorResult {
  id: string; // AniList id
  malId?: number;
  title: { romaji?: string; english?: string; native?: string };
  image?: string;
  totalEpisodes?: number;
  type?: string;
  status?: string;
}

export interface IProviderMapping {
  provider: string;
  id: string; // provider-specific anime id/slug
  title: string;
  score: number; // base title-similarity (0..1), pre-heuristic — what /info reports
}

/** AniList metadata used for matching + verification (resolved once per request). */
interface AniMeta {
  titles: string[]; // english, romaji, native, ...synonyms (filtered) — match ALL; native/synonyms carry ordinals
  episodes?: number; // AniList episode count (final/planned); used as a soft backstop only
  year?: number; // seasonYear ?? startDate.year
  format?: string; // TV, TV_SHORT, MOVIE, OVA, ONA, SPECIAL
  status?: string; // RELEASING means the count is unreliable (ongoing)
  seasonNumber?: number; // sequel ORDINAL parsed from titles/synonyms; undefined if no marker
  part?: number; // split-cour part/cour number (AniList splits these; providers often don't)
}

// --- season-disambiguation tuning (see the heuristic block above bestMatch/rankedMatches) ---
const TITLE_FLOOR = 0.5; // a candidate must clear this on title alone — metadata never rescues a bad title
const MAX_CANDIDATES = 3; // top-N kept per provider for Tier-2 verification
const SEASON_BONUS = 0.15;
const SEASON_PENALTY = 0.3;
const PART_BONUS = 0.1; // split-cour ("Part 2"/"Cour 2") — secondary to the season ordinal
const PART_PENALTY = 0.2;
const YEAR_BONUS = 0.1;
const YEAR_PENALTY = 0.15;
const FORMAT_PENALTY = 0.4; // a TV season mapped onto the movie/OVA, or vice-versa
const EPISODE_COUNT_TOLERANCE = 3; // ± slack for the count backstop (recaps/specials drift)
// Providers whose fetchAnimeInfo is expensive (cloakbrowser render). These verify ONLY their
// top candidate in Tier 2 — never fire extra renders probing alternates.
const BROWSER_BACKED = new Set(['gogoanime']);

const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4 };
const WORD_ORDINAL: Record<string, number> = { second: 2, third: 3, fourth: 4, fifth: 5 };

/**
 * Detect a sequel ORDINAL (>= 2) from a title or a provider slug. Returns `undefined` when no
 * marker is present — i.e. a plain S1 title ("Kaguya-sama wa Kokurasetai") or a named sequel
 * with no number ("Ultra Romantic"). We deliberately only treat numbers tied to a season token
 * as ordinals, so names like "86", "Steins;Gate 0" or "Mob Psycho 100" aren't misread.
 * NOTE: "Part"/"Cour" are handled by {@link detectPart}, NOT here — so "Final Season Part 2"
 * isn't mistaken for "Season 2" and AniList's split cours map to the right half.
 */
export const detectSeasonNumber = (text: string): number | undefined => {
  if (!text) return undefined;
  const s = text.toLowerCase();
  let best: number | undefined;
  const take = (n: number) => {
    if (n >= 2 && n <= 12 && (best === undefined || n > best)) best = n;
  };
  let m: RegExpExecArray | null;
  // "2nd season", "season 2", "season-3", "season_2"
  const reNumThenWord = /(\d{1,2})(?:st|nd|rd|th)?\s*[-_ ]?\s*season\b/g;
  while ((m = reNumThenWord.exec(s))) take(Number(m[1]));
  const reWordThenNum = /\bseason\s*[-_ ]?\s*(\d{1,2})\b/g;
  while ((m = reWordThenNum.exec(s))) take(Number(m[1]));
  // written ordinals: "second season"
  const reWord = /\b(second|third|fourth|fifth)\s+season\b/g;
  while ((m = reWord.exec(s))) take(WORD_ORDINAL[m[1]]);
  // Japanese "2期" / "第2期"
  const reJp = /第?\s*(\d{1,2})\s*期/g;
  while ((m = reJp.exec(s))) take(Number(m[1]));
  // standalone trailing roman numeral token: "... II", "...-iii"
  const reRoman = /(?:^|[\s:_-])(ii|iii|iv)(?=$|[\s:_-])/g;
  while ((m = reRoman.exec(s))) take(ROMAN[m[1]]);
  return best;
};

/**
 * Detect a "Part"/"Cour" number — a sub-division of ONE season. AniList splits these into
 * separate media entries (e.g. Re:Zero "Season 2" vs "Season 2 Part 2"); many providers don't.
 * Kept separate from the season ordinal so the two halves of a cour-split season match correctly.
 * Returns undefined when absent. `part 1` is meaningful here (unlike season, where 1 = unmarked).
 */
export const detectPart = (text: string): number | undefined => {
  if (!text) return undefined;
  const s = text.toLowerCase();
  let best: number | undefined;
  const take = (n: number) => {
    if (n >= 1 && n <= 6 && (best === undefined || n > best)) best = n;
  };
  let m: RegExpExecArray | null;
  const reWordThenNum = /\b(?:part|cour)\s*[-_ ]?\s*(\d{1,2})\b/g;
  while ((m = reWordThenNum.exec(s))) take(Number(m[1]));
  const reNumThenWord = /(\d{1,2})(?:st|nd|rd|th)?\s*[-_ ]?\s*(?:part|cour)\b/g;
  while ((m = reNumThenWord.exec(s))) take(Number(m[1]));
  return best;
};

/** Detect a 4-digit air year (19xx/20xx only, so name-numbers like "0" or "86" don't match). */
export const detectYear = (text: string): number | undefined => {
  const m = (text || '').match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : undefined;
};

const pickTitle = (t: any): string =>
  typeof t === 'string' ? t : t?.english ?? t?.romaji ?? t?.native ?? t?.userPreferred ?? '';

/**
 * AnimeAggregator — the "mega scraper" backbone.
 *
 * Search by AniList (clean GraphQL API, no scraping), then map a title across every configured
 * scraping provider so a client can pick any working source/server per episode (with fallback).
 *
 * SEASON DISAMBIGUATION (two-tier — fixes "S2 plays S1"):
 *   Title is for *recall*, metadata is for *precision*. Matching on title alone breaks on
 *   multi-season shows (near-identical titles), so:
 *   - TIER 1 (cheap, no episode fetches) — `rankedMatches`: title-similarity gets candidates,
 *     then we re-rank by the sequel ordinal (parsed from titles/synonyms vs the result
 *     title/slug), the air year, and format, keeping the top-N per provider. `getMappings`
 *     (used by /info for every provider) stays fast: it returns only the best per provider.
 *   - TIER 2 (verify where we already fetch) — `getEpisodes`: when we pull a candidate's
 *     episode list, we VERIFY it against AniList (exact leaked id for ReAnime; else an explicit
 *     ordinal contradiction; else a finished-show episode-count backstop). On no verified match
 *     we FALL THROUGH to the next provider with a `reason` instead of confidently serving S1.
 *   Defensive: when a signal is absent on either side we apply no adjustment, so single-season
 *   shows behave exactly as before. Tunables are the consts above.
 */
class AnimeAggregator {
  private readonly client: AxiosInstance = axios.create({ timeout: 20000 });
  readonly providers: AnimeParser[];

  /** @param providers anime providers to aggregate (default: AniNeko + AnimeNoSub + AnikotoTV + ReAnime + Gogoanime + AnimeUnity) */
  constructor(providers?: AnimeParser[]) {
    // AniNeko first: browser-free AND carries soft English subs for simulcasts.
    // AnimeNoSub second: browser-free, megaplay soft subs on the back-catalog.
    // AnikotoTV third: browser-free (nekostream backend), HD-1 = megaplay soft subs.
    // ReAnime fourth: browser-free metadata + high-quality .ass subs; video plays
    //   through the curl-impersonate proxy (flixcloud CDN is CF/JA3-gated).
    // Gogoanime/AnimeUnity are fallbacks.
    this.providers = providers ?? [
      new AniNeko(),
      new AnimeNoSub(),
      new AnikotoTV(),
      new ReAnime(),
      new Gogoanime(),
      new AnimeUnity(),
    ];
  }

  /** AniList search (no scraping). */
  search = async (query: string, page = 1, perPage = 15): Promise<IAggregatorResult[]> => {
    const gql = `query ($q: String, $page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
          id idMal title { romaji english native } coverImage { large } format episodes status
        }
      }
    }`;
    const { data } = await this.client.post(ANILIST_GRAPHQL, { query: gql, variables: { q: query, page, perPage } });
    return (data?.data?.Page?.media ?? []).map((m: any) => ({
      id: String(m.id),
      malId: m.idMal ?? undefined,
      title: m.title,
      image: m.coverImage?.large,
      totalEpisodes: m.episodes ?? undefined,
      type: m.format,
      status: m.status,
    }));
  };

  /** AniList metadata (titles + synonyms + episodes/year/format/status + parsed ordinal) for matching. */
  private metaFor = async (anilistId: string | number): Promise<AniMeta> => {
    const gql = `query ($id: Int) {
      Media(id: $id, type: ANIME) {
        title { romaji english native } synonyms format episodes status seasonYear startDate { year }
      }
    }`;
    const { data } = await this.client.post(ANILIST_GRAPHQL, { query: gql, variables: { id: Number(anilistId) } });
    const m = data?.data?.Media ?? {};
    const titles: string[] = [m.title?.english, m.title?.romaji, m.title?.native, ...(m.synonyms ?? [])].filter(Boolean);
    const maxOf = (fn: (t: string) => number | undefined) =>
      titles.map(fn).reduce<number | undefined>((mx, n) => (n != null && (mx == null || n > mx) ? n : mx), undefined);
    return {
      titles,
      episodes: m.episodes ?? undefined,
      year: m.seasonYear ?? m.startDate?.year ?? undefined,
      format: m.format ?? undefined,
      status: m.status ?? undefined,
      seasonNumber: maxOf(detectSeasonNumber),
      part: maxOf(detectPart),
    };
  };

  /** Heuristic adjustment for a single provider result, given AniList meta. Only signals present
   *  on BOTH sides count, so single-season shows (no markers) are never affected. */
  private seasonScoreAdj = (meta: AniMeta, title: string, slug: string): number => {
    let adj = 0;
    const aniS = meta.seasonNumber;
    const resS = detectSeasonNumber(title) ?? detectSeasonNumber(slug);
    if (aniS != null && resS != null) adj += aniS === resS ? SEASON_BONUS : -SEASON_PENALTY;

    const aniP = meta.part;
    const resP = detectPart(title) ?? detectPart(slug);
    if (aniP != null && resP != null) adj += aniP === resP ? PART_BONUS : -PART_PENALTY;

    const aniY = meta.year;
    const resY = detectYear(title) ?? detectYear(slug);
    if (aniY != null && resY != null) adj += aniY === resY ? YEAR_BONUS : -YEAR_PENALTY;

    const f = (meta.format ?? '').toUpperCase();
    if (f) {
      const text = `${title} ${slug}`.toLowerCase();
      const resMovie = /\bmovie\b|\bfilm\b|gekijou/.test(text);
      const resOva = /\bova\b|\boad\b/.test(text);
      // only penalise the clear cross-type case: a non-movie mapped onto something that says "movie", etc.
      if (f !== 'MOVIE' && resMovie) adj -= FORMAT_PENALTY;
      if (f !== 'OVA' && f !== 'ONA' && f !== 'SPECIAL' && resOva) adj -= FORMAT_PENALTY;
    }
    return adj;
  };

  /** TIER 1: top-N title candidates for one provider, re-ranked by season/year/format. */
  private rankedMatches = async (provider: AnimeParser, meta: AniMeta): Promise<IProviderMapping[]> => {
    const res: any = await provider.search(meta.titles[0]);
    const results: any[] = res?.results ?? [];
    const scored: { mapping: IProviderMapping; adjusted: number }[] = [];
    for (const r of results) {
      const rt = pickTitle(r.title);
      if (!rt) continue;
      const slug = String(r.id ?? '');
      const base = Math.max(...meta.titles.map(t => compareTwoStrings(t.toLowerCase(), rt.toLowerCase())));
      if (base < TITLE_FLOOR) continue;
      const adjusted = base + this.seasonScoreAdj(meta, rt, slug);
      scored.push({ mapping: { provider: provider.name, id: r.id, title: rt, score: base }, adjusted });
    }
    scored.sort((a, b) => b.adjusted - a.adjusted);
    return scored.slice(0, MAX_CANDIDATES).map(s => s.mapping);
  };

  /** Resolve AniList meta once + Tier-1 ranked candidates per provider. */
  private rankedFor = async (
    anilistId: string | number
  ): Promise<{ meta: AniMeta; byProvider: Map<string, IProviderMapping[]> }> => {
    const meta = await this.metaFor(anilistId);
    if (meta.titles.length === 0) return { meta, byProvider: new Map() };
    const entries = await Promise.all(
      this.providers.map(async p => {
        const list = await this.rankedMatches(p, meta).catch(() => [] as IProviderMapping[]);
        return [p.name.toLowerCase(), list] as const;
      })
    );
    return { meta, byProvider: new Map(entries) };
  };

  /** Map an AniList id to the best match per provider (for /info). Cheap — no episode fetches. */
  getMappings = async (anilistId: string | number): Promise<IProviderMapping[]> => {
    const { byProvider } = await this.rankedFor(anilistId);
    const best: IProviderMapping[] = [];
    for (const list of byProvider.values()) if (list.length) best.push(list[0]);
    return best.sort((a, b) => b.score - a.score);
  };

  /** TIER 2: verify a fetched candidate is actually the requested season. False ⇒ fall through. */
  private verifyMatch = (info: IAnimeInfo, candidate: IProviderMapping, meta: AniMeta, requestedId: string): boolean => {
    // 1) exact leaked AniList id (ReAnime) — definitive, no fuzziness
    if (info.alID != null && String(info.alID) !== '') return String(info.alID) === requestedId;

    // 2) explicit season contradiction — both sides name an ordinal and they differ
    const candOrdinal = detectSeasonNumber(candidate.title) ?? detectSeasonNumber(String(candidate.id));
    const ordinalDecided = meta.seasonNumber != null && candOrdinal != null;
    if (ordinalDecided && candOrdinal !== meta.seasonNumber) return false;

    // explicit split-cour contradiction — both sides name a part/cour and they differ
    const candPart = detectPart(candidate.title) ?? detectPart(String(candidate.id));
    if (meta.part != null && candPart != null && candPart !== meta.part) return false;

    // 3) episode-count backstop — only when the ordinal couldn't decide, the show is finished,
    //    and AniList gives a count. Tolerant (recaps/specials drift). Never reject ongoing shows.
    if (
      !ordinalDecided &&
      meta.status !== 'RELEASING' &&
      meta.episodes != null &&
      info.episodes?.length &&
      Math.abs(info.episodes.length - meta.episodes) > EPISODE_COUNT_TOLERANCE
    ) {
      return false;
    }
    return true;
  };

  /**
   * Episodes for an AniList id. Walks providers in preference order (requested first, then the
   * configured order — English-subs first, NOT raw title-score). For each provider it verifies
   * its Tier-1 candidates (browser-backed providers only probe the top one) and returns the first
   * that passes verification. If nothing verifies, returns an empty result WITH a `reason` rather
   * than silently serving a wrong-season match.
   */
  getEpisodes = async (
    anilistId: string | number,
    providerName?: string
  ): Promise<{ provider: string | null; providerId?: string; episodes: IAnimeEpisode[]; reason?: string }> => {
    const { meta, byProvider } = await this.rankedFor(anilistId);
    const requestedId = String(anilistId);

    const order = [providerName, ...this.providers.map(p => p.name)].filter(Boolean) as string[];
    const tried = new Set<string>();
    let sawCandidatesButNoneVerified = false;

    for (const name of order) {
      const key = name.toLowerCase();
      if (tried.has(key)) continue;
      tried.add(key);
      const provider = this.providers.find(p => p.name.toLowerCase() === key);
      const candidates = byProvider.get(key) ?? [];
      if (!provider || candidates.length === 0) continue;

      // cost-aware: don't fire extra cloakbrowser renders probing alternates
      const probe = BROWSER_BACKED.has(key) ? candidates.slice(0, 1) : candidates;
      for (const candidate of probe) {
        try {
          const info = await provider.fetchAnimeInfo(candidate.id);
          if (!info.episodes?.length) continue;
          if (this.verifyMatch(info, candidate, meta, requestedId)) {
            return { provider: candidate.provider, providerId: candidate.id, episodes: info.episodes };
          }
          sawCandidatesButNoneVerified = true; // had episodes but failed season verification
        } catch {
          /* try next candidate / provider */
        }
      }
    }
    return {
      provider: null,
      episodes: [],
      reason: sawCandidatesButNoneVerified
        ? 'no candidate matched the requested season (id / ordinal / episode-count) — fell through'
        : 'no provider returned episodes for this title',
    };
  };

  /** Fetch sources for an episode from a named provider. */
  getSources = async (providerName: string, episodeId: string, ...args: any[]): Promise<ISource> => {
    const provider = this.providers.find(p => p.name.toLowerCase() === providerName.toLowerCase());
    if (!provider) throw new Error(`unknown provider: ${providerName}`);
    return provider.fetchEpisodeSources(episodeId, ...args);
  };
}

export default AnimeAggregator;
