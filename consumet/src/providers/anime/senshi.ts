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

/** one resolved playable server (embed) for an episode. Senshi models sub/dub as separate
 * `episode-embeds` entries distinguished by {@link SenshiEmbed.status} — see {@link Senshi} */
interface SenshiSource {
  /** the HLS master playlist (`ninstream.com/<sig>/<ts>/<uuid>/playlist.m3u8`) */
  master: string;
  /** the embed's audio type: `HardSub` (Japanese audio + burned-in English subs = **sub**) or
   * `Dub` (English audio = **dub**) */
  status: string;
  /** friendly server label used as the source's `serverName` (e.g. `Hardsub`, `Dub`, and for a
   * mirror `Hardsub · Server 2`) */
  label: string;
}

/** raw `episode-embeds` array element */
interface SenshiEmbed {
  /** primary HLS master url on the `ninstream.com` CDN (signed, short-TTL) */
  url: string;
  /** optional Server-2 mirror master url (usually null) */
  server2: string | null;
  /** optional Server-FM (Filemoon) mirror master url (usually null) */
  serverFM: string | null;
  /** optional direct download url (usually null) */
  download: string | null;
  /** audio type: `HardSub` or `Dub` */
  status: string;
  /** the `url` with `/playlist.m3u8` stripped (base for variant/segment resolution) */
  masked_base_url: string;
}

/**
 * Senshi (senshi.live) — a **self-hosted** anime source: a React SPA fronted by a clean REST API
 * on `senshi.live` itself (search/anime/episodes/episode-embeds all plain JSON) that hands out
 * signed HLS masters served from its own `ninstream.com` CDN. Genuinely multi-server per episode:
 * each episode exposes one server **per audio type** — `HardSub` (Japanese audio + **burned-in**
 * English subtitles = the **sub** experience) and, where a dub exists, `Dub` (English audio) — the
 * two experiences {@link fetchEpisodeSourcesAll} fans out over. (Subs are burned in — there are no
 * separate soft `.vtt` tracks to surface; the "dubtitles" the site advertises are the hardsubs.)
 *
 * Resolution chain (plain HTTP JSON — no anti-bot on the API path, no TLS impersonation needed):
 * - Search:   `POST /anime/filter` `{searchTerm,page,limit}` → `{data:[{id,public_id,title,
 *             title_english,anime_picture,type,ani_episodes,...}],total}`. (`id` doubles as the
 *             MAL id, but is used verbatim as Senshi's own key throughout.)
 * - Anime:    `GET /anime/<id>`                              → series metadata (title, poster,
 *             `genres` comma-string, `ani_description`, `ani_year`, …).
 * - Episodes: `GET /episodes/<id>`                           → `[{id,ep_id,mal_id,ep_title,
 *             ep_filler,intro_start,intro_end,outro_start,outro_end}]` — `ep_id` is the episode
 *             **number**, which is what the embeds endpoint keys on.
 * - Embeds:   `GET /episode-embeds/<id>/<epNumber>`          → `[{url,server2,serverFM,download,
 *             status,masked_base_url}]` — one entry per audio type (`HardSub`/`Dub`). This is the
 *             multi-server list; `url` is the primary master, `server2`/`serverFM` optional mirrors.
 * - Video:    `ninstream.com/<sig>/<ts>/<uuid>/playlist.m3u8` — real HLS master (1080p, H.264+AAC,
 *             **unencrypted** — no `#EXT-X-KEY`). Segments carry a `.jpg` extension and are served
 *             as `image/jpeg` but are real MPEG-TS (like AniDB's `.xls`/KAA's `.jpg` — the `/proxy`
 *             is extension/content-type agnostic). The CDN is Cloudflare-fronted but **not**
 *             JA3-gated; it gates purely on **`Referer: https://senshi.live/`** (Origin alone → 403,
 *             plain TLS is fine). The proxy injects that Referer (carried on the source's `headers`).
 *             The master URLs are short-TTL signed, so we always resolve fresh at request time.
 *
 * All hosts are plain-fetchable server-side (no curl-impersonate), so nothing is added to
 * `TLS_IMPERSONATE_HOSTS`.
 */
class Senshi extends AnimeParser {
  override readonly name = 'Senshi';
  protected override baseUrl = 'https://senshi.live';
  protected override logo = 'https://senshi.live/assets/favicon-3ErN9bbp.ico';
  protected override classPath = 'ANIME.Senshi';

  /** the value the `ninstream.com` segment CDN requires as `Referer` */
  private static readonly VIDEO_REFERER = 'https://senshi.live/';

  /** embed audio `status` → friendly server label */
  private static readonly STATUS_NAMES: Record<string, string> = {
    HardSub: 'Hardsub',
    Dub: 'Dub',
  };

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  private get apiHeaders() {
    return { 'User-Agent': USER_AGENT, Referer: `${this.baseUrl}/`, 'Content-Type': 'application/json' };
  }

  private statusName = (status: string): string => Senshi.STATUS_NAMES[status] ?? status;

  /** `/posters/<id>.webp` (and other server-relative image paths) → absolute url */
  private imageUrl = (path?: string): string | undefined =>
    path ? (path.startsWith('http') ? path : `${this.baseUrl}${path}`) : undefined;

  private toResult = (item: any): IAnimeResult => ({
    id: String(item.id),
    title: item.title_english || item.title || String(item.id),
    url: `${this.baseUrl}/anime/${item.id}`,
    image: this.imageUrl(item.anime_picture),
    // catalog rows don't declare which audio types exist per episode; that's only known once
    // the embeds are fetched, so advertise BOTH (resolved for real in fetchEpisodeSources).
    subOrDub: SubOrSub.BOTH,
    type: item.type,
  });

  /**
   * @param query search query string
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    const searchResult: ISearch<IAnimeResult> = { currentPage: 1, hasNextPage: false, results: [] };
    try {
      const limit = 20;
      const { data } = await this.client.post(
        `${this.baseUrl}/anime/filter`,
        { searchTerm: query, page: 1, limit },
        { headers: this.apiHeaders }
      );
      const items: any[] = data?.data ?? [];
      searchResult.results = items.filter(i => i?.id != null).map(this.toResult);
      searchResult.hasNextPage = Number(data?.total ?? items.length) > limit;
      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id series id, e.g. `1735` (Naruto: Shippuuden)
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const animeInfo: IAnimeInfo = { id, title: '', url: `${this.baseUrl}/anime/${id}`, episodes: [] };
    try {
      const { data } = await this.client.get(`${this.baseUrl}/anime/${id}`, { headers: this.apiHeaders });
      animeInfo.title = data?.title_english || data?.title || id;
      const image = this.imageUrl(data?.anime_picture);
      if (image) animeInfo.image = image;
      if (data?.ani_description) animeInfo.description = String(data.ani_description).trim();
      if (typeof data?.genres === 'string' && data.genres.trim())
        animeInfo.genres = data.genres.split(',').map((g: string) => g.trim()).filter(Boolean);
      if (data?.ani_year) animeInfo.releaseDate = String(data.ani_year);
      if (data?.type) animeInfo.type = data.type as any;
      animeInfo.subOrDub = SubOrSub.BOTH;

      animeInfo.episodes = await this.parseEpisodeList(id);
      animeInfo.totalEpisodes = animeInfo.episodes.length;
      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId `"<animeId>::<epNumber>"`
   * @param server reserved (Senshi's playable server is always the ninstream HLS master)
   * @param subOrDub `sub` (HardSub, default) or `dub` (Dub)
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const sources = this.orderSources(await this.resolveEmbeds(episodeId), subOrDub);
      if (sources.length === 0) throw new Error('no playable servers returned for episode');
      return this.toSource(sources[0]);
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * Multi-server variant of {@link fetchEpisodeSources}: return one {@link ISource} per server the
   * episode exposes of the requested audio type — the primary `HardSub`/`Dub` master plus any
   * `Server 2`/`Server FM` mirrors it ships. The array is ordered so the requested type's default
   * (index 0 == the singular method's pick) is first, and each result is tagged with `serverName`.
   * Additive: the AnimeParser-interface {@link fetchEpisodeSources} is unchanged.
   *
   * @param episodeId `"<animeId>::<epNumber>"`
   * @param subOrDub `sub` (default) or `dub`
   */
  fetchEpisodeSourcesAll = async (episodeId: string, subOrDub: 'sub' | 'dub' = 'sub'): Promise<ISource[]> => {
    const sources = this.orderSources(await this.resolveEmbeds(episodeId), subOrDub);
    if (sources.length === 0) throw new Error('no playable servers returned for episode');
    return sources.map(this.toSource);
  };

  /**
   * @param episodeId `"<animeId>::<epNumber>"`
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    const sources = await this.resolveEmbeds(episodeId);
    return sources.map(s => ({ name: s.label, url: s.master }));
  };

  /** `GET /episodes/<animeId>` → one flat, ascending, absolutely-numbered episode list */
  private parseEpisodeList = async (animeId: string): Promise<IAnimeEpisode[]> => {
    const { data } = await this.client.get(`${this.baseUrl}/episodes/${animeId}`, { headers: this.apiHeaders });
    const raw: any[] = Array.isArray(data) ? data : data?.episodes ?? [];
    return raw
      .filter(e => e && e.ep_id != null)
      .map(e => {
        const number = Number(e.ep_id) || 0;
        return {
          id: `${animeId}::${number}`,
          number,
          title: e.ep_title || `Episode ${number}`,
          url: `${this.baseUrl}/watch/${animeId}/${number}`,
        };
      })
      .sort((a, b) => a.number - b.number);
  };

  private parseEpisodeId = (episodeId: string): { animeId: string; epNumber: number } => {
    const [animeId, num] = episodeId.split('::');
    return { animeId, epNumber: Number(num) || 1 };
  };

  /** `GET /episode-embeds/<animeId>/<epNumber>` → every playable server (primary + mirrors) */
  private resolveEmbeds = async (episodeId: string): Promise<SenshiSource[]> => {
    const { animeId, epNumber } = this.parseEpisodeId(episodeId);
    const { data } = await this.client.get(`${this.baseUrl}/episode-embeds/${animeId}/${epNumber}`, {
      headers: this.apiHeaders,
    });
    const embeds: SenshiEmbed[] = Array.isArray(data) ? data : [];
    const out: SenshiSource[] = [];
    for (const e of embeds) {
      const base = this.statusName(e.status);
      if (e.url) out.push({ master: e.url, status: e.status, label: base });
      // mirrors are usually null; expose them as extra servers of the same audio type when present
      if (e.server2) out.push({ master: e.server2, status: e.status, label: `${base} · Server 2` });
      if (e.serverFM) out.push({ master: e.serverFM, status: e.status, label: `${base} · Server FM` });
    }
    return out;
  };

  /**
   * Order servers so the requested type is first (index 0 == the auto-play default). Senshi's
   * audio types map onto sub/dub as: `HardSub` = **sub**, `Dub` = **dub**. Every server is kept
   * (no filtering) so the multi-server array surfaces the full set; only the ordering changes.
   */
  private orderSources = (sources: SenshiSource[], subOrDub: 'sub' | 'dub'): SenshiSource[] => {
    const isSub = (s: SenshiSource) => s.status === 'HardSub';
    const preferred = subOrDub === 'dub' ? sources.filter(s => !isSub(s)) : sources.filter(isSub);
    const rest = sources.filter(s => !preferred.includes(s));
    return [...preferred, ...rest];
  };

  private toSource = (s: SenshiSource): ISource => ({
    // the ninstream CDN 403s without this exact Referer (Origin alone is rejected); the proxy
    // injects it. Segments are `.jpg`-disguised MPEG-TS and unencrypted (no key handling needed).
    headers: { Referer: Senshi.VIDEO_REFERER },
    sources: [{ url: s.master, quality: 'auto', isM3U8: true }],
    subtitles: [], // subs are burned into the HardSub video — no separate soft-sub tracks
    serverName: s.label,
  });
}

export default Senshi;
