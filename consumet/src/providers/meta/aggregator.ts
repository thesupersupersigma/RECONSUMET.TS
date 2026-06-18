import axios, { AxiosInstance } from 'axios';

import { AnimeParser, IAnimeEpisode, ISource } from '../../models';
import { compareTwoStrings } from '../../utils/utils';
import AnimeNoSub from '../anime/animenosub';
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
  score: number;
}

/**
 * AnimeAggregator — the "mega scraper" backbone.
 *
 * Search by AniList (clean GraphQL API, no scraping), then map a title across
 * every configured scraping provider by title similarity, so a client can pick
 * any working source/server per episode (with fallback).
 *
 * This is intentionally simpler than the legacy `META.Anilist` (which is wired
 * to malsync + classic-gogoanime slugs that no longer match the surviving
 * clones). Mapping here is pure title-match against each provider's own search.
 */
class AnimeAggregator {
  private readonly client: AxiosInstance = axios.create({ timeout: 20000 });
  readonly providers: AnimeParser[];

  /** @param providers anime providers to aggregate (default: AnimeNoSub + Gogoanime + AnimeUnity) */
  constructor(providers?: AnimeParser[]) {
    // AnimeNoSub first: fully browser-free + English subs on the back-catalog, so
    // the common case needs no cloakbrowser. Gogoanime/AnimeUnity are fallbacks.
    this.providers = providers ?? [new AnimeNoSub(), new Gogoanime(), new AnimeUnity()];
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

  /** All titles (english/romaji/native + synonyms) for an AniList id, for matching. */
  private titlesFor = async (anilistId: string | number): Promise<string[]> => {
    const gql = `query ($id: Int) { Media(id: $id, type: ANIME) { title { romaji english native } synonyms } }`;
    const { data } = await this.client.post(ANILIST_GRAPHQL, { query: gql, variables: { id: Number(anilistId) } });
    const m = data?.data?.Media ?? {};
    return [m.title?.english, m.title?.romaji, m.title?.native, ...(m.synonyms ?? [])].filter(Boolean);
  };

  private titleText = (t: any): string =>
    typeof t === 'string' ? t : t?.english ?? t?.romaji ?? t?.native ?? t?.userPreferred ?? '';

  /** Best title-similarity match for `titles` on a single provider, or null. */
  private bestMatch = async (provider: AnimeParser, titles: string[]): Promise<IProviderMapping | null> => {
    const res: any = await provider.search(titles[0]);
    const results: any[] = res?.results ?? [];
    let best: IProviderMapping | null = null;
    for (const r of results) {
      const rt = this.titleText(r.title).toLowerCase();
      if (!rt) continue;
      const score = Math.max(...titles.map(t => compareTwoStrings(t.toLowerCase(), rt)));
      if (!best || score > best.score) best = { provider: provider.name, id: r.id, title: this.titleText(r.title), score };
    }
    return best && best.score >= 0.5 ? best : null;
  };

  /** Map an AniList id to every provider that has a confident title match. */
  getMappings = async (anilistId: string | number): Promise<IProviderMapping[]> => {
    const titles = await this.titlesFor(anilistId);
    if (titles.length === 0) return [];
    const mappings = await Promise.all(
      this.providers.map(p => this.bestMatch(p, titles).catch(() => null))
    );
    return mappings.filter((m): m is IProviderMapping => m !== null).sort((a, b) => b.score - a.score);
  };

  /**
   * Episodes for an AniList id. Tries the requested provider, else the
   * best-matching provider, falling back through the rest until one yields
   * episodes.
   */
  getEpisodes = async (
    anilistId: string | number,
    providerName?: string
  ): Promise<{ provider: string | null; providerId?: string; episodes: IAnimeEpisode[] }> => {
    const mappings = await this.getMappings(anilistId);
    const byProvider = new Map(mappings.map(m => [m.provider.toLowerCase(), m]));

    // preference order: the requested provider first, then the configured
    // provider order (e.g. Gogoanime before AnimeUnity → English subs first),
    // NOT raw title-score (which can favour a sub-less foreign source).
    const order = [providerName, ...this.providers.map(p => p.name)].filter(Boolean) as string[];
    const tried = new Set<string>();
    for (const name of order) {
      const key = name.toLowerCase();
      if (tried.has(key)) continue;
      tried.add(key);
      const m = byProvider.get(key);
      const provider = this.providers.find(p => p.name.toLowerCase() === key);
      if (!m || !provider) continue;
      try {
        const info = await provider.fetchAnimeInfo(m.id);
        if (info.episodes?.length) return { provider: m.provider, providerId: m.id, episodes: info.episodes };
      } catch {
        /* try next provider */
      }
    }
    return { provider: null, episodes: [] };
  };

  /** Fetch sources for an episode from a named provider. */
  getSources = async (providerName: string, episodeId: string, ...args: any[]): Promise<ISource> => {
    const provider = this.providers.find(p => p.name.toLowerCase() === providerName.toLowerCase());
    if (!provider) throw new Error(`unknown provider: ${providerName}`);
    return provider.fetchEpisodeSources(episodeId, ...args);
  };
}

export default AnimeAggregator;
