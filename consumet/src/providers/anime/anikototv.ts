import { AxiosAdapter } from 'axios';
import { load } from 'cheerio';

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
import { MegaPlay, VibePlayer } from '../../extractors';

/** one server parsed from `/ajax/server/list` */
interface AnikotoServer {
  /** server label, e.g. `HD-1`, `VidCloud-1`, `Kiwi-Stream` */
  name: string;
  /** the encrypted nekostream link-id blob (feeds `/ajax/server?get=`) */
  linkId: string;
  /** `sub` | `dub` */
  type: 'sub' | 'dub';
}

/**
 * AnikotoTV (anikototv.to) — a zoro/hianime-style clone, **fully browser-free**,
 * sitting on the shared **nekostream** backend (same family as {@link AniNeko}).
 *
 * Resolution chain (all plain HTTP):
 * - Search:  `GET /search?keyword=<q>`             → `/watch/<slug>/ep-1` cards.
 * - AnimeId: `GET /watch/<slug>/ep-1`              → `#watch-main[data-id]`.
 * - Episodes:`GET /ajax/episode/list/<animeId>`    → anchors w/ `data-num` + an
 *            encrypted `data-ids` blob (the per-episode server key).
 * - Servers: `GET /ajax/server/list?servers=<data-ids>` → `<li data-link-id>` list.
 * - Embed:   `GET /ajax/server?get=<link-id>`      → `{result:{url}}` — the host
 *            decrypts the blob server-side and hands back a plain embed URL.
 *
 * The embeds are hosts we already extract:
 * - **HD-1 → `megaplay.buzz`** → {@link MegaPlay} (HLS + **English soft subs**).
 * - **Kiwi-Stream → `vibeplayer.site`** (wrapped in `mewcdn.online/player/plyr.php#<b64>#`)
 *   → {@link VibePlayer}.
 *
 * So no new crack: `/ajax/server?get=` does the decryption for us, and HD-1 gives
 * soft English subtitles via megaplay's `tracks[]`.
 */
class AnikotoTV extends AnimeParser {
  override readonly name = 'AnikotoTV';
  protected override baseUrl = 'https://anikototv.to';
  protected override logo = 'https://anikototv.to/AnikotoTheme/assets/images/favicon.png';
  protected override classPath = 'ANIME.AnikotoTV';

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  private get ajaxHeaders() {
    return { 'X-Requested-With': 'XMLHttpRequest', Referer: `${this.baseUrl}/`, 'User-Agent': USER_AGENT };
  }

  /** `/watch/<slug>/ep-N` (or full url) → series slug */
  private slugFromWatchUrl = (href: string): string =>
    (href.match(/\/watch\/([^/?#]+)/) ?? [])[1] ?? '';

  /**
   * @param query search query string
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    const searchResult: ISearch<IAnimeResult> = { currentPage: 1, hasNextPage: false, results: [] };
    try {
      const { data } = await this.client.get(`${this.baseUrl}/search?keyword=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': USER_AGENT },
      });
      const $ = load(data);

      const seen = new Set<string>();
      $('a.name.d-title').each((_i, el) => {
        const a = $(el);
        const slug = this.slugFromWatchUrl(a.attr('href') ?? '');
        if (!slug || seen.has(slug)) return;
        seen.add(slug);
        const item = a.closest('.item');
        const img = item.find('img').first();
        searchResult.results.push({
          id: slug,
          title: a.text().trim() || a.attr('data-jp') || slug,
          url: `${this.baseUrl}/watch/${slug}`,
          image: img.attr('data-src') || img.attr('src'),
          subOrDub: SubOrSub.BOTH,
        });
      });

      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id series slug, e.g. `re-zero-...-season-4-4hk9h`
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const slug = this.slugFromWatchUrl(id) || id;
    const animeInfo: IAnimeInfo = { id: slug, title: '', url: `${this.baseUrl}/watch/${slug}`, episodes: [] };

    try {
      const { data: watch } = await this.client.get(`${this.baseUrl}/watch/${slug}/ep-1`, {
        headers: { Referer: this.baseUrl, 'User-Agent': USER_AGENT },
      });
      const $ = load(watch);

      const animeId = $('#watch-main').attr('data-id');
      if (!animeId) throw new Error('could not find anime data-id on watch page');

      animeInfo.title = $('h1').first().text().trim() || slug;
      const image = $('meta[property="og:image"]').attr('content');
      if (image) animeInfo.image = image;
      const description = $('meta[property="og:description"]').attr('content');
      if (description) animeInfo.description = description;

      const episodes = await this.parseEpisodeList(animeId);
      animeInfo.episodes = episodes.map(e => ({
        id: `${animeId}/${e.number}`, // refetch the data-ids blob fresh at source time
        number: e.number,
        title: e.title,
        url: `${this.baseUrl}/watch/${slug}/ep-${e.number}`,
      }));
      animeInfo.totalEpisodes = animeInfo.episodes.length;

      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId `"<animeId>/<ep>"`
   * @param server reserved (we prefer HD-1/megaplay for soft subs)
   * @param subOrDub `sub` (default) or `dub`
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const servers = await this.parseServers(episodeId);
      if (servers.length === 0) throw new Error('no servers returned by /ajax/server/list');

      const ofType = servers.filter(s => s.type === subOrDub);
      const pool = ofType.length ? ofType : servers;
      // HD-1 = megaplay = soft English subs; otherwise take the first available.
      const pick = pool.find(s => /HD-1/i.test(s.name)) ?? pool[0];

      const embed = await this.resolveEmbed(pick.linkId);
      if (!embed) throw new Error(`could not resolve embed for server ${pick.name}`);

      return await this.extractEmbed(embed);
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId `"<animeId>/<ep>"`
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    const servers = await this.parseServers(episodeId);
    return servers.map(s => ({ name: `${s.name} (${s.type})`, url: s.linkId }));
  };

  /** `/ajax/episode/list/<animeId>` → `[{number,title}]` (also caches data-ids per ep) */
  private parseEpisodeList = async (animeId: string): Promise<IAnimeEpisode[]> => {
    const { data } = await this.client.get(`${this.baseUrl}/ajax/episode/list/${animeId}`, {
      headers: this.ajaxHeaders,
    });
    const $ = load(data.result ?? '');
    const episodes: IAnimeEpisode[] = [];
    $('a[data-num]').each((_i, el) => {
      const number = parseFloat($(el).attr('data-num') ?? '') || episodes.length + 1;
      episodes.push({ id: '', number, title: $(el).attr('title') || `Episode ${number}` });
    });
    episodes.sort((a, b) => a.number - b.number);
    return episodes;
  };

  /** fetch the fresh `data-ids` blob for an episode, then list its servers */
  private parseServers = async (episodeId: string): Promise<AnikotoServer[]> => {
    const [animeId, ep] = episodeId.split('/');

    const { data: list } = await this.client.get(`${this.baseUrl}/ajax/episode/list/${animeId}`, {
      headers: this.ajaxHeaders,
    });
    const $list = load(list.result ?? '');
    const anchor = $list(`a[data-num="${ep}"]`).first();
    const dataIds = anchor.attr('data-ids');
    if (!dataIds) throw new Error(`episode ${ep} not found in list for anime ${animeId}`);

    const { data: srv } = await this.client.get(`${this.baseUrl}/ajax/server/list`, {
      headers: this.ajaxHeaders,
      params: { servers: dataIds },
    });
    const $ = load(srv.result ?? '');

    // dub/sub signal (verified live, Jul 2026): `/ajax/server/list` wraps every server
    // in a `<div class="type" data-type="sub|dub">…<ul><li data-link-id>…`. Confirmed each
    // `li[data-link-id]` sits inside a `.type` wrapper (none flat/un-wrapped) and dub servers
    // are reliably under `data-type="dub"` — so reading the wrapper's `data-type` is the
    // reliable signal (unlike AniNeko, there is no subtitle-param ambiguity here). `.trim()
    // .toLowerCase()` guards against casing/whitespace drift; any non-`dub` value → `sub`.
    const servers: AnikotoServer[] = [];
    $('.type').each((_i, typeEl) => {
      const type = (($(typeEl).attr('data-type') ?? '').trim().toLowerCase() === 'dub' ? 'dub' : 'sub') as
        | 'sub'
        | 'dub';
      $(typeEl)
        .find('li[data-link-id]')
        .each((_j, li) => {
          const linkId = $(li).attr('data-link-id');
          if (!linkId) return;
          servers.push({ name: $(li).text().trim() || 'server', linkId, type });
        });
    });
    return servers;
  };

  /** `/ajax/server?get=<link-id>` → the decrypted embed URL */
  private resolveEmbed = async (linkId: string): Promise<string> => {
    const { data } = await this.client.get(`${this.baseUrl}/ajax/server`, {
      headers: this.ajaxHeaders,
      params: { get: linkId },
    });
    return data?.result?.url ?? '';
  };

  /** route a resolved embed URL to the right extractor */
  private extractEmbed = async (embed: string): Promise<ISource> => {
    // some hosts wrap the real embed as `…/plyr.php#<base64 of inner url>#`
    let url = embed;
    const wrapped = embed.match(/#([A-Za-z0-9+/=]+)#/)?.[1];
    if (wrapped) {
      try {
        const decoded = Buffer.from(wrapped, 'base64').toString('utf8');
        if (/^https?:\/\//.test(decoded)) url = decoded;
      } catch (_) {
        /* keep original */
      }
    }

    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return '';
      }
    })();

    if (host.includes('megaplay')) {
      return new MegaPlay(this.proxyConfig, this.adapter).extract(new URL(url));
    }
    if (host.includes('vibeplayer')) {
      return new VibePlayer(this.proxyConfig, this.adapter).extract(new URL(url));
    }
    // direct HLS fallthrough
    if (url.includes('.m3u8')) {
      return {
        headers: { Referer: `${host ? `https://${host}` : this.baseUrl}/` },
        sources: [{ url, quality: 'auto', isM3U8: true }],
        subtitles: [],
      };
    }
    throw new Error(`unsupported embed host: ${host || embed}`);
  };
}

export default AnikotoTV;
