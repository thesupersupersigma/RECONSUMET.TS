import { AxiosAdapter } from 'axios';
import { load } from 'cheerio';

import {
  AnimeParser,
  ISearch,
  IAnimeInfo,
  IEpisodeServer,
  StreamingServers,
  SubOrSub,
  IAnimeResult,
  ISource,
  ProxyConfig,
} from '../../models';
import { USER_AGENT } from '../../utils';
import { MegaPlay } from '../../extractors';

/**
 * Gogoanime — rebuilt for the surviving clone **gogoanimez.to** (+ the
 * `gogoanime.com.by`/megaplay.buzz video backend). The original gogocdn
 * architecture is dead.
 *
 * Everything is plain HTTP. The episode list on the anime info page is
 * populated client-side via a WordPress AJAX call
 * (`admin-ajax.php?action=load_episode_range`), but the nonce and range/seri
 * params it needs are already present in the page's raw (non-JS-rendered)
 * HTML, so `fetchAnimeInfo` just replicates that call directly instead of
 * needing a browser to execute the site's own JS.
 *
 * Video + English subtitles come from the {@link MegaPlay} extractor.
 */
class Gogoanime extends AnimeParser {
  override readonly name = 'Gogoanime';
  protected override baseUrl = 'https://gogoanimez.to';
  protected override logo =
    'https://play-lh.googleusercontent.com/MaGEiAEhNHAJXcXKzqTNgxqRmhuKB1rCUgb15UrN_mWUNRnLpO5T1qja64oRasO7mn0';
  protected override classPath = 'ANIME.Gogoanime';

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  private slugFromAnimeUrl = (href: string): string =>
    (href.match(/\/anime\/([^/]+)\/?/) ?? [])[1] ?? '';

  private slugFromEpisodeUrl = (href: string): string =>
    (href.match(/\/([^/]+-episode-[0-9.]+)\/?$/) ?? [])[1] ?? '';

  /**
   * @param query search query string
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    const searchResult: ISearch<IAnimeResult> = { currentPage: 1, hasNextPage: false, results: [] };
    try {
      const { data } = await this.client.get(`${this.baseUrl}/?s=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': USER_AGENT },
      });
      const $ = load(data);

      $('div.last_episodes ul.items > li').each((_i, el) => {
        const a = $(el).find('div.img a').first();
        const href = a.attr('href');
        const id = href ? this.slugFromAnimeUrl(href) : '';
        if (!id) return;
        searchResult.results.push({
          id,
          title: a.attr('title') ?? $(el).find('.name a').text().trim(),
          url: `${this.baseUrl}/anime/${id}/`,
          image: $(el).find('div.img img').attr('src'),
          subOrDub: SubOrSub.SUB,
        });
      });

      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id anime slug, e.g. `naruto-2002`
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const url = id.startsWith('http') ? id : `${this.baseUrl}/anime/${id}/`;
    const animeInfo: IAnimeInfo = { id, title: '', url, episodes: [] };

    try {
      const { data: html } = await this.client.get(url, { headers: { 'User-Agent': USER_AGENT } });
      const $ = load(html);

      animeInfo.title = $('.anime_info_body_bg h1, h1').first().text().trim() || id;
      const image = $('.anime_info_body_bg img, .anime-poster img, div.img img').first().attr('src');
      if (image) animeInfo.image = image;
      const description = $('.description, .anime_info_body_bg .description').first().text().trim();
      if (description) animeInfo.description = description;

      // range buttons (labelled e.g. "1-19", "20-119") carry the seri id the
      // AJAX endpoint keys off of; the nonce it also requires sits in the
      // inline script the page ships alongside them — both are present in
      // the raw (non-JS-rendered) HTML, no browser needed to read either.
      const ranges: { start: number; end: number; seri: string }[] = [];
      $('#episode_page > li a').each((_i, el) => {
        const start = Number($(el).attr('data-range-start'));
        const end = Number($(el).attr('data-range-end'));
        const seri = $(el).attr('data-seri');
        if (seri && Number.isFinite(start) && Number.isFinite(end)) ranges.push({ start, end, seri });
      });
      const nonce = (html.match(/nonce:\s*'([a-f0-9]+)'/) ?? [])[1];

      if (ranges.length === 0 || !nonce) {
        throw new Error('no episode ranges/nonce found on the anime page — page layout may have changed');
      }

      const slugs = new Set<string>();
      for (const { start, end, seri } of ranges) {
        const { data: ajax } = await this.client.post(
          `${this.baseUrl}/wp-admin/admin-ajax.php`,
          new URLSearchParams({
            action: 'load_episode_range',
            range_start: String(start),
            range_end: String(end),
            seri_id: seri,
            nonce,
          }),
          { headers: { 'User-Agent': USER_AGENT, Referer: url } }
        );
        if (!ajax?.success || typeof ajax.data !== 'string') continue;
        const $range = load(ajax.data);
        $range('a').each((_i, el) => {
          const href = $range(el).attr('href');
          const slug = href ? this.slugFromEpisodeUrl(href) : '';
          if (slug) slugs.add(slug);
        });
      }

      if (slugs.size === 0) {
        throw new Error('no episodes returned from load_episode_range — is the site up?');
      }

      const numOf = (s: string) => parseFloat((s.match(/-episode-([0-9.]+)/) ?? [])[1] ?? '0');
      const base = [...slugs][0].replace(/-episode-[0-9.]+$/, '');
      const episodes = [...slugs]
        .map(slug => ({ id: slug, number: numOf(slug), url: `${this.baseUrl}/${slug}/` }))
        .sort((a, b) => a.number - b.number);

      // some sites expose a trailing episode beyond the labelled ranges (e.g. the
      // finale) — probe forward a few and append any that exist.
      const max = episodes.length ? episodes[episodes.length - 1].number : 0;
      for (let n = max + 1; n <= max + 4; n++) {
        const slug = `${base}-episode-${n}`;
        if (!(await this.episodeExists(slug))) break;
        episodes.push({ id: slug, number: n, url: `${this.baseUrl}/${slug}/` });
      }

      animeInfo.episodes = episodes;
      animeInfo.totalEpisodes = episodes.length;

      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId episode slug, e.g. `naruto-episode-1`
   * @param server unused (kept for interface compat); MegaPlay is the only backend
   * @param subOrDub `sub` (default) or `dub`
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const embed = await this.resolveMegaplayUrl(episodeId, subOrDub);
      return await new MegaPlay(this.proxyConfig, this.adapter).extract(new URL(embed));
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId episode slug, e.g. `naruto-episode-1`
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    const url = episodeId.startsWith('http') ? episodeId : `${this.baseUrl}/${episodeId}/`;
    const { data } = await this.client.get(url, { headers: { Referer: this.baseUrl, 'User-Agent': USER_AGENT } });
    const $ = load(data);

    const servers: IEpisodeServer[] = [];
    $('[data-video]').each((_i, el) => {
      const src = load($(el).attr('data-video') ?? '')('iframe').attr('src');
      if (!src) return;
      const type = /type=dub/.test(src) ? 'dub' : 'sub';
      const serverName = (src.match(/server=([^&]+)/) ?? [])[1] ?? 'megaplay';
      servers.push({ name: `${serverName} (${type})`, url: src });
    });
    return servers;
  };

  /** true if the episode page exists and carries a player (used to find trailing episodes) */
  private episodeExists = async (episodeSlug: string): Promise<boolean> => {
    try {
      const { data } = await this.client.get(`${this.baseUrl}/${episodeSlug}/`, {
        headers: { Referer: this.baseUrl, 'User-Agent': USER_AGENT },
        validateStatus: () => true,
        maxRedirects: 0,
      });
      return typeof data === 'string' && data.includes('data-video');
    } catch {
      return false;
    }
  };

  /** episode page -> data-video (streaming.php) -> nested megaplay embed url */
  private resolveMegaplayUrl = async (episodeId: string, subOrDub: 'sub' | 'dub'): Promise<string> => {
    const url = episodeId.startsWith('http') ? episodeId : `${this.baseUrl}/${episodeId}/`;
    const { data } = await this.client.get(url, { headers: { Referer: this.baseUrl, 'User-Agent': USER_AGENT } });
    const $ = load(data);

    const streamUrls: string[] = [];
    $('[data-video]').each((_i, el) => {
      const src = load($(el).attr('data-video') ?? '')('iframe').attr('src');
      if (src) streamUrls.push(src);
    });
    if (streamUrls.length === 0) throw new Error('no player found on episode page');

    const streamUrl =
      streamUrls.find(s => s.includes(`type=${subOrDub}`)) ?? streamUrls[0];

    const { data: wrap } = await this.client.get(streamUrl, { headers: { Referer: this.baseUrl } });
    const embed = load(wrap)('iframe').attr('src');
    if (!embed || !embed.includes('megaplay')) throw new Error(`unsupported player: ${embed ?? 'none'}`);
    return embed;
  };
}

export default Gogoanime;
