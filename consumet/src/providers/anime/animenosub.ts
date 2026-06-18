import { AxiosAdapter } from 'axios';
import { load } from 'cheerio';

import {
  AnimeParser,
  ISearch,
  IAnimeInfo,
  IAnimeResult,
  IAnimeEpisode,
  IEpisodeServer,
  IVideo,
  ISource,
  StreamingServers,
  SubOrSub,
  MediaStatus,
  ProxyConfig,
} from '../../models';
import { USER_AGENT } from '../../utils';
import { MegaPlay, VidMoly } from '../../extractors';

/** one decoded entry from the episode page's `<select class="mirror">` */
interface Mirror {
  /** raw option label, e.g. `SUB - HD`, `SUB - Moon` */
  label: string;
  /** `sub` | `dub` | `raw` (first token of the label) */
  type: string;
  /** server name, e.g. `HD`, `Moon`, `Omega`, `Nova` */
  name: string;
  /** absolute embed url decoded from the base64 option value */
  url: string;
}

/**
 * AnimeNoSub (animenosub.to) — a WordPress / `animestream`-theme anime site.
 *
 * Unlike {@link Gogoanime}, **every step is plain HTTP** — search, the anime
 * page's episode list, and the per-episode server list are all server-rendered.
 * No browser, no nonce wall, and no ads (we never execute the page).
 *
 * The per-episode servers live in a `<select class="mirror">` whose `<option>`
 * values are **base64-encoded `<iframe>` HTML**. Two backends, split by title
 * age:
 *  - back-catalog → `megaplay.buzz` (labelled `HD`) → m3u8 + **English subs**
 *    via the existing {@link MegaPlay} extractor.
 *  - newer / simulcast → `Moon` (Filemoon), `Omega` (Vidmoly), `Nova`
 *    (`nova.upn.one`). These need their own extractors — not yet supported, so
 *    {@link fetchEpisodeSources} throws a clear, actionable error for them.
 */
class AnimeNoSub extends AnimeParser {
  override readonly name = 'AnimeNoSub';
  protected override baseUrl = 'https://animenosub.to';
  protected override logo = 'https://animenosub.to/favicon.png';
  protected override classPath = 'ANIME.AnimeNoSub';

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  private slugFromAnimeUrl = (href: string): string => (href.match(/\/anime\/([^/]+)\/?/) ?? [])[1] ?? '';

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

      $('div.listupd article.bs div.bsx > a').each((_i, el) => {
        const a = $(el);
        const href = a.attr('href') ?? '';
        const id = this.slugFromAnimeUrl(href);
        if (!id) return;
        const hasDub = a.find('.ans-dub').length > 0;
        const hasSub = a.find('.ans-sub').length > 0;
        searchResult.results.push({
          id,
          title: a.attr('title') ?? a.find('.tt').first().text().trim(),
          url: `${this.baseUrl}/anime/${id}/`,
          image: a.find('img').first().attr('src'),
          subOrDub: hasSub && hasDub ? SubOrSub.BOTH : hasDub ? SubOrSub.DUB : SubOrSub.SUB,
        });
      });

      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id anime slug, e.g. `naruto-shippuden`
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const url = id.startsWith('http') ? id : `${this.baseUrl}/anime/${id}/`;
    const animeInfo: IAnimeInfo = { id: this.slugFromAnimeUrl(url) || id, title: '', url, episodes: [] };

    try {
      const { data } = await this.client.get(url, {
        headers: { Referer: this.baseUrl, 'User-Agent': USER_AGENT },
      });
      const $ = load(data);

      animeInfo.title = $('.infox h1.entry-title').first().text().trim() || id;
      const image = $('.thumb img').first().attr('src');
      if (image) animeInfo.image = image;
      const description = $('.entry-content[itemprop="description"]').text().trim();
      if (description) animeInfo.description = description;

      const genres = new Set<string>();
      $('.genxed a, .info a[href*="/genres/"], .spe a[href*="/genres/"]').each((_i, el) => {
        const g = $(el).text().trim();
        if (g) genres.add(g);
      });
      if (genres.size) animeInfo.genres = [...genres];

      const statusText = $('.spe span:contains("Status")').text().toLowerCase();
      animeInfo.status = statusText.includes('completed')
        ? MediaStatus.COMPLETED
        : statusText.includes('ongoing')
          ? MediaStatus.ONGOING
          : MediaStatus.UNKNOWN;

      const episodes: IAnimeEpisode[] = [];
      $('div.eplister ul li a').each((_i, el) => {
        const a = $(el);
        const href = a.attr('href') ?? '';
        const epId = this.slugFromEpisodeUrl(href);
        if (!epId) return;
        const number = parseFloat(a.find('.epl-num').text().trim()) || episodes.length + 1;
        episodes.push({
          id: epId,
          number,
          title: a.find('.epl-title').text().trim() || undefined,
          url: `${this.baseUrl}/${epId}/`,
          releaseDate: a.find('.epl-date').text().trim() || undefined,
        });
      });
      episodes.sort((x, y) => x.number - y.number);

      animeInfo.episodes = episodes;
      animeInfo.totalEpisodes = episodes.length;

      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * Resolve a playable source for an episode.
   *
   * Preference: **MegaPlay/HD** first (it carries English subtitles), then
   * **Omega/Vidmoly** (video only — captions come from the external subtitle
   * layer). The **Moon** (Filemoon/Byse) and **Nova** servers use encrypted /
   * session-bound backends and are not yet supported; they raise a clear error.
   *
   * @param episodeId episode slug, e.g. `naruto-shippuden-episode-1`
   * @param server reserved for explicit server selection (unused for now)
   * @param subOrDub `sub` (default) or `dub`
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const mirrors = await this.parseMirrors(episodeId);
      if (mirrors.length === 0) throw new Error('no servers found on episode page');

      // prefer the requested type (sub/dub); fall back to any if none match
      const ofType = mirrors.filter(m => m.type === subOrDub);
      const pool = ofType.length ? ofType : mirrors;

      const megaplay = pool.find(m => /megaplay\./i.test(m.url));
      if (megaplay) {
        return await new MegaPlay(this.proxyConfig, this.adapter).extract(new URL(megaplay.url));
      }

      const vidmoly = pool.find(m => /vidmoly\./i.test(m.url));
      if (vidmoly) {
        const origin = new URL(vidmoly.url).origin;
        const sources = (await new VidMoly(this.proxyConfig, this.adapter).extract(
          new URL(vidmoly.url)
        )) as IVideo[];
        // Vidmoly's m3u8 CDN is Referer-locked to the embed origin.
        return { headers: { Referer: `${origin}/` }, sources, subtitles: [] };
      }

      const offered = [...new Set(mirrors.map(m => `${m.name} (${m.type})`))].join(', ');
      throw new Error(
        `no supported server for this episode. Offered: ${offered || 'none'}. ` +
          `Supported: MegaPlay/HD (with subs) and Omega/Vidmoly (video). ` +
          `Moon (Filemoon/Byse) and Nova use encrypted backends — not yet supported.`
      );
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId episode slug, e.g. `naruto-shippuden-episode-1`
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    const mirrors = await this.parseMirrors(episodeId);
    return mirrors.map(m => ({ name: m.label, url: m.url }));
  };

  /** episode page → `<select class="mirror">` → base64-decoded iframe embeds */
  private parseMirrors = async (episodeId: string): Promise<Mirror[]> => {
    const url = episodeId.startsWith('http') ? episodeId : `${this.baseUrl}/${episodeId}/`;
    const { data } = await this.client.get(url, {
      headers: { Referer: this.baseUrl, 'User-Agent': USER_AGENT },
    });
    const $ = load(data);

    const mirrors: Mirror[] = [];
    $('select.mirror option').each((_i, el) => {
      const value = $(el).attr('value');
      if (!value) return; // skip the placeholder "Select Video Server"
      let src: string | undefined;
      try {
        const decoded = Buffer.from(value, 'base64').toString('utf-8');
        src = load(decoded)('iframe').attr('src');
      } catch {
        return;
      }
      if (!src) return;
      if (src.startsWith('//')) src = `https:${src}`;

      const label = $(el).text().trim();
      const type = (label.match(/^([a-z]+)/i)?.[1] ?? 'sub').toLowerCase();
      const name = label.split(/\s*-\s*/).pop()?.trim() || 'unknown';
      mirrors.push({ label, type, name, url: src });
    });
    return mirrors;
  };
}

export default AnimeNoSub;
