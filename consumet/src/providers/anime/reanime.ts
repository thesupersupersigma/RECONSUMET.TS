import { AxiosAdapter } from 'axios';

import {
  AnimeParser,
  ISearch,
  IAnimeInfo,
  IAnimeResult,
  IAnimeEpisode,
  IEpisodeServer,
  ISource,
  StreamingServers,
  SubOrSub,
  ProxyConfig,
} from '../../models';
import { USER_AGENT } from '../../utils';
import { FlixCloud } from '../../extractors';

/** one server from `GET /api/flix/<anilistId>/<ep>` */
interface FlixServer {
  /** server label, e.g. `HD-2` */
  name: string;
  /** the embed url, e.g. `https://flixcloud.cc/e/<id>?v=2` */
  url: string;
  /** `sub` | `dub` */
  type: 'sub' | 'dub';
}

/**
 * Re:ANIME (reanime.to) — a SvelteKit site with a clean, **browser-free** REST API.
 *
 * - Search:    `GET /api/v1/search?q=<query>`            → AniList-backed results.
 * - Episodes:  `GET /api/v1/anime/<slug>/episodes`       → `ep-N` list.
 * - Metadata:  `GET /api/v1/watch/<slug>?ep=1`           → title/cover/anilist id.
 * - Servers:   `GET /api/flix/<anilistId>/<ep>`          → `flixcloud.cc` embeds.
 *
 * **What it gives us today:** high-quality, *unencrypted* `.ass` English soft
 * subtitles (fansub-grade), pulled by the {@link FlixCloud} extractor straight out
 * of the embed. **What it does not (yet):** the m3u8 — flixcloud guards the manifest
 * behind a megacloud-tier WASM+PBKDF2+AES+token chain (see `SOURCES.md`). Until that
 * crack is done, `fetchEpisodeSources` returns subtitles with an empty `sources`.
 *
 * The `/api/flix` route is keyed by **AniList media id**, which we read from the
 * `bx<id>` AniList cover-image URL in the watch payload (and which the aggregator
 * already knows). Episode ids are therefore `"<anilistId>/<ep>"`.
 */
class ReAnime extends AnimeParser {
  override readonly name = 'ReAnime';
  protected override baseUrl = 'https://reanime.to';
  protected override logo = 'https://reanime.to/og.png';
  protected override classPath = 'ANIME.ReAnime';

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  private get apiHeaders() {
    return { Accept: 'application/json', Referer: `${this.baseUrl}/`, 'User-Agent': USER_AGENT };
  }

  /** pull the AniList media id out of an `anilistcdn/.../bx<id>-hash.jpg` url */
  private anilistIdFrom = (text: string): string =>
    (text.match(/anilistcdn\/media\/anime\/(?:cover|banner)\/[^"']*?(\d+)-/) ?? [])[1] ?? '';

  /**
   * @param query search query string
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    const searchResult: ISearch<IAnimeResult> = { currentPage: 1, hasNextPage: false, results: [] };
    try {
      const { data } = await this.client.get(
        `${this.baseUrl}/api/v1/search?q=${encodeURIComponent(query)}&limit=20`,
        { headers: this.apiHeaders }
      );

      for (const r of data?.results ?? []) {
        const slug: string = r.anime_id;
        if (!slug) continue;
        const title = r.title?.english || r.title?.romaji || r.title?.native || slug;
        searchResult.results.push({
          id: slug,
          title,
          url: `${this.baseUrl}/watch/${slug}`,
          image: r.cover_image?.large || r.cover_image?.extra_large,
          subOrDub: r.dubbed ? SubOrSub.BOTH : SubOrSub.SUB,
        });
      }

      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id series slug, e.g. `re-zero-...-4tz8eg`
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const slug = id.replace(/^https?:\/\/[^/]+\/watch\//, '');
    const animeInfo: IAnimeInfo = { id: slug, title: '', url: `${this.baseUrl}/watch/${slug}`, episodes: [] };

    try {
      // one watch call resolves title/cover + the AniList id the flix route needs
      const { data: watch } = await this.client.get(`${this.baseUrl}/api/v1/watch/${slug}?ep=1`, {
        headers: this.apiHeaders,
      });
      const anime = watch?.anime ?? {};
      animeInfo.title = anime.title?.english || anime.title?.romaji || anime.title?.user_preferred || slug;
      const image = anime.cover_image?.large || anime.cover_image?.extra_large;
      if (image) animeInfo.image = image;
      if (anime.banner_image) animeInfo.cover = anime.banner_image;
      if (anime.description) animeInfo.description = anime.description;

      const anilistId = String(anime.anilist ?? '') || this.anilistIdFrom(JSON.stringify(anime));
      if (!anilistId) throw new Error('could not resolve AniList id for flix lookup');

      const { data: eps } = await this.client.get(
        `${this.baseUrl}/api/v1/anime/${slug}/episodes?limit=2000`,
        { headers: this.apiHeaders }
      );

      const episodes: IAnimeEpisode[] = [];
      for (const e of eps?.data ?? []) {
        const number = Number(e.episode_number) || episodes.length + 1;
        episodes.push({
          id: `${anilistId}/${number}`, // self-contained: flix is keyed by anilist id + ep
          number,
          title: e.title || `Episode ${number}`,
          url: `${this.baseUrl}/watch/${slug}?ep=${number}`,
          isFiller: !!e.is_filler,
        });
      }
      episodes.sort((a, b) => a.number - b.number);

      animeInfo.episodes = episodes;
      animeInfo.totalEpisodes = episodes.length;

      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * Resolve subtitles (and, once the stream crack lands, video) for an episode.
   *
   * @param episodeId `"<anilistId>/<ep>"`
   * @param server reserved for explicit server selection (unused — only HD-2/flixcloud)
   * @param subOrDub `sub` (default) or `dub`
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const servers = await this.parseServers(episodeId);
      if (servers.length === 0) throw new Error('no servers returned by /api/flix');

      const ofType = servers.filter(s => s.type === subOrDub);
      const pick = (ofType.length ? ofType : servers)[0];

      return await new FlixCloud(this.proxyConfig, this.adapter).extract(new URL(pick.url));
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId `"<anilistId>/<ep>"`
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    const servers = await this.parseServers(episodeId);
    return servers.map(s => ({ name: `${s.name} (${s.type})`, url: s.url }));
  };

  /** `GET /api/flix/<anilistId>/<ep>` → `flixcloud.cc` embeds (parsed defensively) */
  private parseServers = async (episodeId: string): Promise<FlixServer[]> => {
    const [anilistId, ep] = episodeId.split('/');
    const { data } = await this.client.get(`${this.baseUrl}/api/flix/${anilistId}/${ep}`, {
      headers: this.apiHeaders,
      // the route can stream/append data, so read it as text and regex it
      transformResponse: [(d: any) => d],
    });

    const servers: FlixServer[] = [];
    const re = /"serverName":"([^"]+)","dataLink":"([^"]+)","dataType":"(sub|dub)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(data))) !== null) {
      servers.push({ name: m[1], url: m[2], type: m[3] as 'sub' | 'dub' });
    }
    return servers;
  };
}

export default ReAnime;
