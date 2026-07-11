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
  ISubtitle,
  StreamingServers,
  SubOrSub,
  ProxyConfig,
} from '../../models';
import { USER_AGENT } from '../../utils';
import { VibePlayer } from '../../extractors';

/** one parsed `data-video` server from a `/watch/<slug>/ep-N` player page */
interface NekoServer {
  /** server label, e.g. `HD-1`, `StreamHG`, `Doodstream` */
  name: string;
  /** the embed url (with any `?sub=`/`caption_1=`/`c1_file=` query intact) */
  url: string;
  /** embed host, e.g. `vibeplayer.site` */
  host: string;
  /** `sub` | `dub` (from the server tab's `data-id`; vtt-name heuristic as fallback) */
  type: 'sub' | 'dub';
  /** true if a separate (soft) English `.vtt` is attached */
  soft: boolean;
  /** the attached English subtitle url, if any */
  subtitle?: string;
}

/**
 * AniNeko (anineko.to) — a hianime-style clone, **fully browser-free**.
 *
 * - Search: `GET /browser?keyword=<q>` → `/watch/<slug>` cards.
 * - Info/episodes: `GET /watch/<slug>` → episode grid linking `/watch/<slug>/ep-N`.
 * - Player/servers: `GET /watch/<slug>/ep-N` → server-rendered `[data-video]`
 *   embeds. (The `?ep=N` URL is the *info* page and has no player — use `/ep-N`.)
 *
 * **The differentiator:** the Soft-Sub servers carry a separate English `.vtt`
 * **directly in the `data-video` query string** (`?sub=` / `caption_1=` /
 * `c1_file=`, on `cdn.anizara.store`). So this is the project's first source with
 * **extractable soft English subtitles for simulcasts** — no megaplay/back-catalog
 * dependency, no external subtitle API. Video for the "HD-1" server comes from the
 * {@link VibePlayer} extractor.
 */
class AniNeko extends AnimeParser {
  override readonly name = 'AniNeko';
  protected override baseUrl = 'https://anineko.to';
  protected override logo = 'https://anineko.to/img/logo.png';
  protected override classPath = 'ANIME.AniNeko';

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  private slugFromWatchUrl = (href: string): string => (href.match(/\/watch\/([^?#]+)/) ?? [])[1] ?? '';

  /**
   * @param query search query string
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    const searchResult: ISearch<IAnimeResult> = { currentPage: 1, hasNextPage: false, results: [] };
    try {
      const { data } = await this.client.get(`${this.baseUrl}/browser?keyword=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': USER_AGENT },
      });
      const $ = load(data);

      $('article.nv-anime-card a.nv-anime-thumb').each((_i, el) => {
        const a = $(el);
        const href = a.attr('href') ?? '';
        const id = this.slugFromWatchUrl(href);
        if (!id || id.includes('/')) return; // skip episode links; want the series slug
        const img = a.find('img').first();
        searchResult.results.push({
          id,
          title: img.attr('alt') ?? a.attr('title') ?? id,
          url: `${this.baseUrl}/watch/${id}`,
          image: img.attr('src'),
          subOrDub: SubOrSub.BOTH,
        });
      });

      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id series slug, e.g. `rezero-starting-life-in-another-world-season-4`
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const url = id.startsWith('http') ? id : `${this.baseUrl}/watch/${id}`;
    const animeInfo: IAnimeInfo = { id: this.slugFromWatchUrl(url) || id, title: '', url, episodes: [] };

    try {
      const { data } = await this.client.get(url, { headers: { Referer: this.baseUrl, 'User-Agent': USER_AGENT } });
      const $ = load(data);

      animeInfo.title = $('h1').first().text().trim() || id;
      const image = $('meta[property="og:image"]').attr('content');
      if (image) animeInfo.image = image;
      const description = $('meta[property="og:description"]').attr('content');
      if (description) animeInfo.description = description;

      const episodes: IAnimeEpisode[] = [];
      const seen = new Set<string>();
      $('article.nv-info-episode-item a.nv-info-episode-main').each((_i, el) => {
        const href = $(el).attr('href') ?? '';
        const epId = this.slugFromWatchUrl(href); // `<slug>/ep-N`
        if (!epId || seen.has(epId)) return;
        seen.add(epId);
        const number = parseFloat((epId.match(/\/ep-([0-9.]+)/) ?? [])[1] ?? '0') || episodes.length + 1;
        episodes.push({
          id: epId,
          number,
          title: $(el).find('strong').first().text().trim() || `Episode ${number}`,
          url: `${this.baseUrl}/watch/${epId}`,
        });
      });
      episodes.sort((a, b) => a.number - b.number);

      animeInfo.episodes = episodes;
      animeInfo.totalEpisodes = episodes.length;

      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * Resolve a playable source + English subtitles for an episode.
   *
   * Prefers the **soft-sub HD-1 (VibePlayer)** server: video m3u8 + a separate
   * English `.vtt` (so the captions are toggleable, even on simulcasts). Falls
   * back to any HD-1 server of the requested type.
   *
   * @param episodeId `<slug>/ep-N`, e.g. `rezero-...-season-4/ep-1`
   * @param server reserved for explicit server selection (unused for now)
   * @param subOrDub `sub` (default) or `dub`
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const servers = await this.parseServers(episodeId);
      if (servers.length === 0) throw new Error('no servers found on player page');

      const ofType = servers.filter(s => s.type === subOrDub);
      const pool = ofType.length ? ofType : servers;

      // VibePlayer ("HD-1") is the wired video backend. Key on the soft-sub signal first —
      // it's the actual differentiator this server exists for, and survives a host rename —
      // then fall back to the host string. AniNeko renamed this host off `vibeplayer.site`
      // (observed July 2026, e.g. `vivibebe.site`), so check both old and new names rather
      // than hard-coding one, so a future rename doesn't silently break this again.
      const vibe =
        pool.find(s => s.soft) ?? pool.find(s => s.host.includes('vibeplayer') || s.host.includes('vivibebe'));
      if (!vibe) {
        const offered = [...new Set(servers.map(s => `${s.name}/${s.host} (${s.type}${s.soft ? ',soft' : ''})`))].join(', ');
        throw new Error(`no VibePlayer/HD-1 server (only wired backend). Offered: ${offered}`);
      }

      const result = await new VibePlayer(this.proxyConfig, this.adapter).extract(new URL(vibe.url));
      if (vibe.subtitle) {
        const subs: ISubtitle[] = [{ url: vibe.subtitle, lang: 'English' }];
        result.subtitles = subs;
      }
      return result;
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * Multi-server variant of {@link fetchEpisodeSources}: resolve EVERY server of the requested
   * type through {@link VibePlayer} (the wired backend) and return one {@link ISource} per
   * server that resolves. Non-VibePlayer servers simply fail to extract and are skipped
   * (logged, not thrown). The array is ordered so the singular method's default pick — the
   * **soft-sub VibePlayer** (else any VibePlayer) — is first, so a consumer taking index 0
   * gets today's exact default behavior. Each result carries its server's own English `.vtt`
   * (when present) and a `serverName` tag. Additive: {@link fetchEpisodeSources} is unchanged.
   *
   * @param episodeId `<slug>/ep-N`
   * @param subOrDub `sub` (default) or `dub`
   */
  fetchEpisodeSourcesAll = async (episodeId: string, subOrDub: 'sub' | 'dub' = 'sub'): Promise<ISource[]> => {
    const servers = await this.parseServers(episodeId);
    if (servers.length === 0) throw new Error('no servers found on player page');

    const ofType = servers.filter(s => s.type === subOrDub);
    const pool = ofType.length ? ofType : servers;

    // default pick, kept first so index 0 == the auto-play default. The first two clauses mirror
    // the singular fetchEpisodeSources selector EXACTLY, so parity holds wherever it still works.
    // The rest are host-rename resilience: AniNeko has moved the VibePlayer/HD-1 backend off
    // `vibeplayer.site` (e.g. `vivibebe.site`), which the host check no longer matches — fall back
    // to the server carrying an English .vtt (the soft-sub differentiator this source exists for;
    // `soft` is the name-confirmed subset, `subtitle` catches vtts whose name doesn't match the
    // `_sub_` heuristic), then the first available, so the soft-sub HD-1 still lands at index 0.
    const pick =
      pool.find(s => s.host.includes('vibeplayer') && s.soft) ??
      pool.find(s => s.host.includes('vibeplayer')) ??
      pool.find(s => s.soft) ??
      pool.find(s => s.subtitle) ??
      pool[0];
    const ordered = pick ? [pick, ...pool.filter(s => s !== pick)] : [...pool];

    const settled = await Promise.allSettled(
      ordered.map(async s => {
        const src = await new VibePlayer(this.proxyConfig, this.adapter).extract(new URL(s.url));
        if (s.subtitle) src.subtitles = [{ url: s.subtitle, lang: 'English' }];
        src.serverName = s.name;
        return src;
      })
    );

    const out: ISource[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') out.push(r.value);
      else
        console.warn(
          `[AniNeko] server "${ordered[i].name}" (${ordered[i].host}, ${subOrDub}) failed: ${(r.reason as Error)?.message ?? r.reason}`
        );
    });
    if (out.length === 0) throw new Error('all servers failed to resolve');
    return out;
  };

  /**
   * @param episodeId `<slug>/ep-N`
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    const servers = await this.parseServers(episodeId);
    return servers.map(s => ({ name: `${s.name} (${s.type}${s.soft ? ', soft' : ''})`, url: s.url }));
  };

  /** player page → `[data-video]` embeds, categorised by the server tab they hang under */
  private parseServers = async (episodeId: string): Promise<NekoServer[]> => {
    const url = episodeId.startsWith('http') ? episodeId : `${this.baseUrl}/watch/${episodeId}`;
    const { data } = await this.client.get(url, { headers: { Referer: this.baseUrl, 'User-Agent': USER_AGENT } });
    const $ = load(data);

    // PRIMARY dub/sub signal (verified live, Jul 2026): AniNeko groups servers under
    // `.nv-server-tab` buttons, each carrying `data-id` (`hsub` | `sub` | `dub`) plus a
    // `tab_N` class; every `[data-video]` server links to its tab via `data-tab="tab_N"`.
    // So `data-id="dub"` is the real, subtitle-INDEPENDENT dub marker. This matters because
    // true dub servers frequently ship with NO subtitle query param (dub audio needs no vtt)
    // — e.g. /watch/naruto/ep-1, where all servers are param-less — so the old vtt-name
    // heuristic silently bucketed those dubs as `sub`. We map `tab_N` → type here and use it
    // as the primary signal; the vtt `_dub_`/`_sub_` heuristic is only a fallback for pages
    // that lack the tabs. (`hsub` hardsub and `sub` softsub both count as `sub`.)
    const tabType = new Map<string, 'sub' | 'dub'>();
    $('.nv-server-tab').each((_i, el) => {
      const tabKey = ($(el).attr('class') ?? '').split(/\s+/).find(c => /^tab_\d+$/.test(c));
      const dataId = ($(el).attr('data-id') ?? '').trim().toLowerCase();
      if (tabKey && dataId) tabType.set(tabKey, dataId === 'dub' ? 'dub' : 'sub');
    });

    const servers: NekoServer[] = [];
    $('[data-video]').each((_i, el) => {
      const video = $(el).attr('data-video');
      if (!video) return;
      let host = '';
      try {
        host = new URL(video).host;
      } catch {
        return;
      }
      // the English .vtt rides in one of several query params, depending on host
      const params = new URL(video).searchParams;
      const subtitle = params.get('sub') ?? params.get('caption_1') ?? params.get('c1_file') ?? undefined;
      // primary: the server tab's data-id; fallback: legacy vtt-name heuristic
      const tabbed = tabType.get(($(el).attr('data-tab') ?? '').trim());
      const type: 'sub' | 'dub' = tabbed ?? (/_dub_eng|_dub_/i.test(subtitle ?? '') ? 'dub' : 'sub');
      servers.push({
        name: $(el).text().trim().slice(0, 24) || host,
        url: video,
        host,
        type,
        soft: !!subtitle && /_sub_eng|_sub_/i.test(subtitle),
        subtitle,
      });
    });
    return servers;
  };
}

export default AniNeko;
