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
import BrowserFetcher from '../../utils/browser-fetcher';
import { MegaPlay } from '../../extractors';

/**
 * Gogoanime — rebuilt for the surviving clone **gogoanimez.to** (+ the
 * `gogoanime.com.by`/megaplay.buzz video backend). The original gogocdn
 * architecture is dead.
 *
 * - `search` and `fetchEpisodeSources` work over plain HTTP.
 * - `fetchAnimeInfo`'s episode list is behind a JS anti-bot wall, so it is
 *   rendered through a running cloakbrowser (see {@link BrowserFetcher}). If no
 *   browser is reachable it throws a clear, actionable error.
 * - Video + English subtitles come from the {@link MegaPlay} extractor.
 */
class Gogoanime extends AnimeParser {
  override readonly name = 'Gogoanime';
  protected override baseUrl = 'https://gogoanimez.to';
  protected override logo =
    'https://play-lh.googleusercontent.com/MaGEiAEhNHAJXcXKzqTNgxqRmhuKB1rCUgb15UrN_mWUNRnLpO5T1qja64oRasO7mn0';
  protected override classPath = 'ANIME.Gogoanime';

  private readonly browser: BrowserFetcher;

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter, cdpUrl?: string) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
    this.browser = new BrowserFetcher(cdpUrl);
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
      const data = await this.browser.withPage(async page => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page
          .waitForSelector('#episode_related > li a', { timeout: 25000 })
          .catch(() => {});

        const meta = await page.evaluate(() => ({
          title: (document.querySelector('.anime_info_body_bg h1, h1')?.textContent || '').trim(),
          image:
            document.querySelector('.anime_info_body_bg img, .anime-poster img, div.img img')?.getAttribute('src') ||
            '',
          description: (document.querySelector('.description, .anime_info_body_bg .description')?.textContent || '').trim(),
        }));

        // the default-loaded range gives us the episode-slug base; the range
        // buttons (labelled e.g. "1-19", "20-119", "120-219") give the max.
        const hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('#episode_related > li a')).map(a => a.getAttribute('href') || '')
        );
        const rangeLabels = await page.evaluate(() =>
          Array.from(document.querySelectorAll('#episode_page > li a')).map(a => a.textContent || '')
        );

        return { meta, hrefs, rangeLabels };
      });

      animeInfo.title = data.meta.title || id;
      if (data.meta.image) animeInfo.image = data.meta.image;
      if (data.meta.description) animeInfo.description = data.meta.description;

      const loadedSlugs: string[] = data.hrefs.map((h: string) => this.slugFromEpisodeUrl(h)).filter(Boolean);
      if (loadedSlugs.length === 0) {
        throw new Error(
          'no episodes rendered — is cloakbrowser reachable and able to pass the site challenge?'
        );
      }

      // episode-slug base, e.g. `naruto` from `naruto-episode-50`
      const base = loadedSlugs[0].replace(/-episode-[0-9.]+$/, '');
      const numOf = (s: string) => parseFloat((s.match(/-episode-([0-9.]+)/) ?? [])[1] ?? '0');
      const loadedMax = Math.max(...loadedSlugs.map(numOf));
      const rangeMax = data.rangeLabels.reduce((mx: number, label: string) => {
        const m = label.match(/(\d+)\s*-\s*(\d+)/);
        return m ? Math.max(mx, Number(m[1]), Number(m[2])) : mx;
      }, 0);
      let max = Math.max(loadedMax, rangeMax, 1);

      // construct the full contiguous list (reliable — avoids flaky range clicks)
      const make = (n: number) => ({ id: `${base}-episode-${n}`, number: n, url: `${this.baseUrl}/${base}-episode-${n}/` });
      const episodes = Array.from({ length: max }, (_v, i) => make(i + 1));

      // some sites expose a trailing episode beyond the labelled ranges (e.g. the
      // finale) — probe forward a few and append any that exist.
      for (let n = max + 1; n <= max + 4; n++) {
        if (!(await this.episodeExists(`${base}-episode-${n}`))) break;
        episodes.push(make(n));
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
