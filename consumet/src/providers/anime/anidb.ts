import { spawn } from 'child_process';

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

/** one language/server offered for an episode by `/api/frontend/episode/<id>/languages` */
interface AniDBLanguage {
  /** audio-language code, e.g. `jpn` (subbed/original) or `eng` (dubbed) */
  code: string;
  /** display name, e.g. `Japanese`, `English` — used as the result's `serverName` */
  name: string;
  /** the `/embed/<token>` page url that hosts the JWPlayer for this language */
  embedUrl: string;
}

/**
 * AniDB (anidb.app) — a **self-hosted** anime source: search, episodes, per-language
 * servers, embed pages and the HLS master all live on `anidb.app` / `hls.anidb.app`
 * (its footer disclaimer about "indexing third-party content" is false to the request
 * chain — no third-party host is ever touched). Genuinely multi-server: each episode
 * offers one server **per audio language** (e.g. Japanese + English), which is the
 * fan-out point {@link fetchEpisodeSourcesAll} exercises.
 *
 * Resolution chain:
 * - Search:    `GET /search/suggestions?q=<q>`               → `a[data-search-item]`
 *              cards linking `/anime/<slug>` (slug ends in the numeric anime id).
 * - Episodes:  `GET /api/frontend/anime/<numericId>/episodes` → `{episodes:[{id,number}]}`
 *              (uses the **numeric** id parsed off the slug, NOT the slug itself).
 * - Languages: `GET /api/frontend/episode/<episodeId>/languages` → `{languages:[{code,
 *              name,embed_url}]}` — one entry per audio language. This is the multi-server list.
 * - Embed:     `GET /embed/<token>`                           → a JWPlayer page whose
 *              `file:` value is the HLS master, e.g. `https://hls.anidb.app/stream/<t>/master.m3u8`.
 * - Video:     that master is real, un-gated own-CDN HLS. **Segments carry a `.xls`
 *              extension and are served as `application/vnd.ms-excel` but are real MPEG-TS** —
 *              the API `/proxy` is already extension/content-type agnostic, so nothing special
 *              is needed here.
 *
 * **Cloudflare gate:** `anidb.app` (all of search/episodes/languages/embed) sits behind a
 * Cloudflare **TLS-fingerprint** managed challenge — plain axios/fetch get `403 "Just a
 * moment"`; only a browser JA3 clears it (no JS/cookie solving needed). So every anidb.app
 * request goes through **curl-impersonate** ({@link fetchImpersonated}), reusing the same
 * `CURL_IMPERSONATE_BIN` the API `/proxy` uses. The `hls.anidb.app` video CDN is **not**
 * gated (plain fetch reaches it), so the returned master needs no impersonation to play.
 */
class AniDB extends AnimeParser {
  override readonly name = 'AniDB';
  protected override baseUrl = 'https://anidb.app';
  protected override logo = 'https://anidb.app/favicon.ico';
  protected override classPath = 'ANIME.AniDB';

  /** the curl-impersonate binary + args shared with the API `/proxy` (env-driven) */
  private readonly impersonateBin = process.env.CURL_IMPERSONATE_BIN || '';
  private readonly impersonateArgs = (process.env.CURL_IMPERSONATE_ARGS || '').split(' ').filter(Boolean);

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  /** `/anime/<slug>` (or slug) → slug; slug's trailing digits are the numeric anime id */
  private slugFromUrl = (href: string): string => (href.match(/\/anime\/([^/?#]+)/) ?? [])[1] ?? href;
  private numericId = (slug: string): string => (slug.match(/(\d+)$/) ?? [])[1] ?? slug;

  /**
   * @param query search query string
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    const searchResult: ISearch<IAnimeResult> = { currentPage: 1, hasNextPage: false, results: [] };
    try {
      const html = await this.fetchImpersonated(`${this.baseUrl}/search/suggestions?q=${encodeURIComponent(query)}`);
      const $ = load(html);

      const seen = new Set<string>();
      $('a[data-search-item]').each((_i, el) => {
        const a = $(el);
        const slug = this.slugFromUrl(a.attr('href') ?? '');
        if (!slug || seen.has(slug)) return;
        seen.add(slug);
        const img = a.find('img').first();
        searchResult.results.push({
          id: slug,
          title: a.find('p').first().text().trim() || img.attr('alt') || slug,
          url: `${this.baseUrl}/anime/${slug}`,
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
   * @param id series slug, e.g. `naruto-3686`
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const slug = this.slugFromUrl(id);
    const url = `${this.baseUrl}/anime/${slug}`;
    const animeInfo: IAnimeInfo = { id: slug, title: '', url, episodes: [] };

    try {
      const page = await this.fetchImpersonated(url);
      const $ = load(page);
      animeInfo.title =
        ($('meta[property="og:title"]').attr('content') ?? '').replace(/\s*[—–-]\s*AniDB\s*$/i, '').trim() ||
        $('h1').first().text().trim() ||
        slug;
      const image = $('meta[property="og:image"]').attr('content');
      if (image) animeInfo.image = image;
      const description = $('meta[property="og:description"]').attr('content');
      if (description) animeInfo.description = description.trim();

      const episodes = await this.parseEpisodeList(this.numericId(slug), slug);
      animeInfo.episodes = episodes;
      animeInfo.totalEpisodes = episodes.length;

      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId numeric episode id, e.g. `70219`
   * @param server reserved (AniDB's "servers" are the audio languages, resolved below)
   * @param subOrDub `sub` (Japanese/original, default) or `dub` (English/other) — picks the
   *   default language; the full per-language list is available via {@link fetchEpisodeSourcesAll}
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const languages = this.orderLanguages(await this.parseLanguages(episodeId), subOrDub);
      if (languages.length === 0) throw new Error('no languages/servers returned for episode');
      return await this.resolveLanguage(languages[0]);
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * Multi-server variant of {@link fetchEpisodeSources}: resolve **every** audio language
   * offered for the episode, in parallel, and return one {@link ISource} per language that
   * resolves. Languages that fail are skipped (logged, not thrown). The array is ordered so
   * the requested `subOrDub` default lands first (index 0 == the singular method's pick), and
   * each result is tagged with `serverName` = the language name (e.g. `Japanese`, `English`)
   * so a consumer can label/select between them. Additive: the AnimeParser-interface
   * {@link fetchEpisodeSources} is unchanged.
   *
   * @param episodeId numeric episode id
   * @param subOrDub `sub` (default) or `dub` — controls only the ordering/default, not filtering
   */
  fetchEpisodeSourcesAll = async (episodeId: string, subOrDub: 'sub' | 'dub' = 'sub'): Promise<ISource[]> => {
    const languages = this.orderLanguages(await this.parseLanguages(episodeId), subOrDub);
    if (languages.length === 0) throw new Error('no languages/servers returned for episode');

    const settled = await Promise.allSettled(languages.map(lang => this.resolveLanguage(lang)));

    const out: ISource[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') out.push(r.value);
      else
        console.warn(
          `[AniDB] language "${languages[i].name}" (${languages[i].code}) failed: ${(r.reason as Error)?.message ?? r.reason}`
        );
    });
    if (out.length === 0) throw new Error('all languages failed to resolve');
    return out;
  };

  /**
   * @param episodeId numeric episode id
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    const languages = await this.parseLanguages(episodeId);
    return languages.map(l => ({ name: l.name, url: l.embedUrl }));
  };

  /** `/api/frontend/anime/<numericId>/episodes` → `[{id,number,title,url}]` */
  private parseEpisodeList = async (numericId: string, slug: string): Promise<IAnimeEpisode[]> => {
    const body = await this.fetchImpersonated(`${this.baseUrl}/api/frontend/anime/${numericId}/episodes`);
    const data = JSON.parse(body);
    const raw: any[] = Array.isArray(data) ? data : data.episodes ?? [];
    const episodes: IAnimeEpisode[] = raw
      .filter(e => e && e.id != null)
      .map(e => {
        const number = Number(e.number) || 0;
        return {
          id: String(e.id), // the numeric episode id feeds `/languages`
          number,
          title: e.title || `Episode ${number}`,
          url: `${this.baseUrl}/anime/${slug}`,
        };
      });
    episodes.sort((a, b) => a.number - b.number);
    return episodes;
  };

  /** `/api/frontend/episode/<episodeId>/languages` → the per-language server list */
  private parseLanguages = async (episodeId: string): Promise<AniDBLanguage[]> => {
    const body = await this.fetchImpersonated(`${this.baseUrl}/api/frontend/episode/${episodeId}/languages`);
    const data = JSON.parse(body);
    const raw: any[] = Array.isArray(data) ? data : data.languages ?? [];
    return raw
      .filter(l => l && l.embed_url)
      .map(l => ({ code: String(l.code ?? '').toLowerCase(), name: l.name || l.code || 'Unknown', embedUrl: l.embed_url }));
  };

  /**
   * Order languages so the requested type is first (index 0 == the auto-play default).
   * AniDB's audio languages map onto sub/dub as: `jpn` (original) = **sub**, anything else = **dub**.
   * Every language is kept (no filtering) so the multi-server array surfaces them all.
   */
  private orderLanguages = (languages: AniDBLanguage[], subOrDub: 'sub' | 'dub'): AniDBLanguage[] => {
    const isSub = (l: AniDBLanguage) => l.code === 'jpn';
    const preferred = subOrDub === 'dub' ? languages.filter(l => !isSub(l)) : languages.filter(isSub);
    const rest = languages.filter(l => !preferred.includes(l));
    return [...preferred, ...rest];
  };

  /** resolve one language's embed → JWPlayer `file:` HLS master → tagged {@link ISource} */
  private resolveLanguage = async (lang: AniDBLanguage): Promise<ISource> => {
    const embed = await this.fetchImpersonated(lang.embedUrl);
    const master = (embed.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/) ?? [])[1];
    if (!master) throw new Error(`no JWPlayer file: m3u8 in embed for ${lang.code}`);
    return {
      headers: { Referer: `${this.baseUrl}/` },
      sources: [{ url: master, quality: 'auto', isM3U8: true }],
      subtitles: [], // no separate soft-sub tracks — the JWPlayer config carries none
      serverName: lang.name,
    };
  };

  /**
   * Fetch an `anidb.app` URL through curl-impersonate (browser JA3) to clear the Cloudflare
   * TLS challenge, reusing the API `/proxy`'s `CURL_IMPERSONATE_BIN`. **Throws loudly** if the
   * binary is unset — anidb.app returns `403 "Just a moment"` to any non-impersonated client,
   * so a missing binary must fail obviously rather than silently returning empty results.
   */
  private fetchImpersonated = (url: string): Promise<string> =>
    new Promise((resolve, reject) => {
      if (!this.impersonateBin) {
        return reject(
          new Error(
            'AniDB requires curl-impersonate: CURL_IMPERSONATE_BIN is not set. anidb.app is behind a ' +
              'Cloudflare TLS-fingerprint challenge, so plain requests return HTTP 403 ("Just a moment"). ' +
              'Set CURL_IMPERSONATE_BIN (+ CURL_IMPERSONATE_ARGS="--impersonate chrome124") — the same binary the API /proxy uses.'
          )
        );
      }
      const args = [
        ...this.impersonateArgs,
        '-sS',
        '-L',
        '--max-time',
        '30',
        '-H',
        `Referer: ${this.baseUrl}/`,
        '-H',
        'X-Requested-With: XMLHttpRequest',
        '-H',
        'Accept: */*',
        url,
      ];
      const child = spawn(this.impersonateBin, args);
      const out: Buffer[] = [];
      let err = '';
      child.stdout.on('data', d => out.push(d as Buffer));
      child.stderr.on('data', d => (err += d.toString()));
      child.on('error', e => reject(e));
      child.on('close', code => {
        if (code !== 0) return reject(new Error(`curl-impersonate exited ${code}: ${err.slice(0, 200) || 'no output'}`));
        const body = Buffer.concat(out).toString('utf8');
        if (/Just a moment|challenge-platform|cf-mitigated/i.test(body)) {
          return reject(
            new Error(
              'AniDB: Cloudflare challenge not cleared — the curl-impersonate profile may be wrong ' +
                '(try CURL_IMPERSONATE_ARGS="--impersonate chrome124").'
            )
          );
        }
        resolve(body);
      });
    });
}

export default AniDB;
