import { AxiosAdapter } from 'axios';

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

/** one resolved audio-locale stream for an episode (KAA models sub/dub as per-locale episodes
 * that share a single multi-audio HLS master — see {@link KickAssAnime}) */
interface KaaSource {
  /** the HLS master (`hls.krussdomi.com/manifest/<id>/master.m3u8`) — carries both a Japanese
   * and (where dubbed) an English audio group */
  master: string;
  /** requested audio locale, e.g. `ja-JP`, `en-US` */
  locale: string;
  /** ISO 639-2 audio-track language to force as the manifest default (`eng` for the English
   * dub); unset for the original, whose Japanese track is already `DEFAULT=YES`. Threaded to
   * the proxy so the dub actually plays English rather than the manifest's default Japanese. */
  audioDefault?: string;
  /** soft subtitle tracks (English `.vtt` off the player), if any */
  subtitles: ISubtitle[];
}

/**
 * KickAssAnime (kaa.lt) — a **self-hosted** anime source: a clean JSON API on `kaa.lt/api`
 * fronts video served from its own `krussdomi.com` player + `hls.krussdomi.com` CDN. Genuinely
 * multi-audio: a single episode's VidStreaming HLS master ships **both** a Japanese (original =
 * **sub**) and, where a dub exists, an English audio group — the two `subOrDub` experiences
 * {@link fetchEpisodeSourcesAll} fans out over.
 *
 * Resolution chain (plain HTTP JSON — no anti-bot on the API path):
 * - Search:   `POST /api/fsearch` `{query}`                    → `{result:[{slug,title,title_en,
 *             poster,locales,episode_count,type,synopsis,genres,watch_uri}]}`.
 * - Show:     `GET /api/show/<slug>`                           → series metadata (+ `watch_uri`).
 * - Episodes: `GET /api/show/<slug>/episodes?ep=<n>&lang=<loc>` → `{pages:[{from,to,eps[]}],
 *             result:[{slug,episode_number,title}]}` — `pages` enumerates every episode number;
 *             `result` is the (≤100-episode) page containing `ep`. **Sub and dub are separate
 *             per-locale episode slugs** (e.g. ja-JP `ep-1-12cd96` vs en-US `ep-1-2da064`).
 * - Episode:  `GET /api/show/<slug>/episode/ep-<n>-<slug>`     → `{servers:[{name,src}],language}`.
 *             Servers: **VidStreaming** (HLS — what we use) and **BirdStream** (`type=dash` — a
 *             DASH manifest this HLS pipeline can't play, so it's skipped). Non-JP/EN dub locales
 *             (e.g. Spanish) are typically BirdStream-only → not exposed as playable HLS.
 * - Player:   `GET krussdomi.com/cat-player/player?id=<id>&source=vidstream&ln=<loc>` → an Astro
 *             page whose island `props` carry the `manifest` (HLS master) + `subtitles` (English
 *             `.vtt`). Sub and dub share the same `id`/master; `ln` is only a client audio hint.
 * - Video:    `hls.krussdomi.com/manifest/<id>/master.m3u8` — real HLS (Japanese `DEFAULT=YES` +
 *             English audio groups). Segments are `.jpg`-disguised MPEG-TS on **rotating throwaway
 *             CDN hosts** (`st1.*.xyz`) that Cloudflare-gate on **`Origin: https://krussdomi.com`**
 *             (Referer alone → 403; plain TLS is fine, no JA3 impersonation needed). The proxy
 *             injects that Origin (carried on the source's `headers`) and, for the dub, rewrites
 *             the master so the English audio group is `DEFAULT` (via `audioDefault`).
 *
 * All hosts are plain-fetchable server-side (no curl-impersonate), so nothing is added to
 * `TLS_IMPERSONATE_HOSTS`.
 */
class KickAssAnime extends AnimeParser {
  override readonly name = 'KickAssAnime';
  protected override baseUrl = 'https://kaa.lt';
  protected override logo = 'https://kaa.lt/favicon.svg';
  protected override classPath = 'ANIME.KickAssAnime';

  /** player/CDN origin — the value the segment CDN requires as `Referer`/`Origin` */
  private static readonly PLAYER_ORIGIN = 'https://krussdomi.com';
  private static readonly HLS_BASE = 'https://hls.krussdomi.com/manifest';

  private get apiUrl(): string {
    return `${this.baseUrl}/api`;
  }

  /** CR-style locale → display name (falls back to the raw code) */
  private static readonly LOCALE_NAMES: Record<string, string> = {
    'ja-JP': 'Japanese',
    'en-US': 'English',
    'es-ES': 'Spanish (Spain)',
    'es-419': 'Spanish (LatAm)',
    'pt-BR': 'Portuguese (Brazil)',
    'fr-FR': 'French',
    'de-DE': 'German',
    'it-IT': 'Italian',
    'ar-SA': 'Arabic',
  };

  /** locale → ISO 639-2 audio-track code as used in the master's `LANGUAGE="…"` attribute */
  private static readonly AUDIO_CODES: Record<string, string> = {
    'ja-JP': 'jpn',
    'en-US': 'eng',
    'es-ES': 'spa',
    'es-419': 'spa',
    'pt-BR': 'por',
    'fr-FR': 'fre',
    'de-DE': 'ger',
    'it-IT': 'ita',
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

  private localeName = (locale: string): string => KickAssAnime.LOCALE_NAMES[locale] ?? locale;

  /** `kaa.lt/image/poster/<key>.webp` for a poster/banner image object */
  private imageUrl = (img: any): string | undefined => {
    const key = img?.hq || img?.sm;
    return key ? `${this.baseUrl}/image/poster/${key}.webp` : undefined;
  };

  private toResult = (item: any): IAnimeResult => {
    const locales: string[] = item.locales ?? [];
    const subbed = locales.includes('ja-JP') || locales.length === 0;
    const dubbed = locales.some(l => l !== 'ja-JP');
    return {
      id: item.slug,
      title: item.title_en || item.title || item.slug,
      url: `${this.baseUrl}/${item.slug}`,
      image: this.imageUrl(item.poster),
      subOrDub: subbed && dubbed ? SubOrSub.BOTH : dubbed ? SubOrSub.DUB : SubOrSub.SUB,
      type: item.type,
    };
  };

  /**
   * @param query search query string
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    const searchResult: ISearch<IAnimeResult> = { currentPage: 1, hasNextPage: false, results: [] };
    try {
      const { data } = await this.client.post(
        `${this.apiUrl}/fsearch`,
        { query },
        { headers: this.apiHeaders }
      );
      const items: any[] = data?.result ?? [];
      searchResult.results = items.filter(i => i?.slug).map(this.toResult);
      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id series slug, e.g. `naruto-f3cf`
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const animeInfo: IAnimeInfo = { id, title: '', url: `${this.baseUrl}/${id}`, episodes: [] };
    try {
      const { data } = await this.client.get(`${this.apiUrl}/show/${id}`, { headers: this.apiHeaders });
      animeInfo.title = data?.title_en || data?.title || id;
      const image = this.imageUrl(data?.poster);
      if (image) animeInfo.image = image;
      const cover = this.imageUrl(data?.banner);
      if (cover) animeInfo.cover = cover;
      if (data?.synopsis) animeInfo.description = data.synopsis;
      if (Array.isArray(data?.genres)) animeInfo.genres = data.genres;
      if (data?.year) animeInfo.releaseDate = String(data.year);

      const locales: string[] = data?.locales ?? ['ja-JP'];
      animeInfo.subOrDub = locales.includes('ja-JP') && locales.some(l => l !== 'ja-JP')
        ? SubOrSub.BOTH
        : locales.some(l => l !== 'ja-JP')
        ? SubOrSub.DUB
        : SubOrSub.SUB;

      animeInfo.episodes = await this.parseEpisodeList(id, locales);
      animeInfo.totalEpisodes = animeInfo.episodes.length;
      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId `"<showSlug>::<epNumber>::<locales>"` — the locales ride along so sub/dub
   *   can be resolved per-locale without re-looking-up the show
   * @param server reserved (KAA's playable server is always VidStreaming/HLS)
   * @param subOrDub `sub` (Japanese/original, default) or `dub` (English)
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const { showSlug, epNumber, locales } = this.parseEpisodeId(episodeId);
      const targets = this.targetLocales(locales, subOrDub);
      if (targets.length === 0) throw new Error('no audio locales available for episode');
      // try targets in order; return the first that resolves to a playable HLS server
      let lastErr: unknown;
      for (const loc of targets) {
        try {
          return this.toSource(await this.resolveLocale(showSlug, epNumber, loc));
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr ?? new Error('no playable server');
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * Multi-server variant of {@link fetchEpisodeSources}: resolve **every** audio locale of the
   * requested type in parallel and return one {@link ISource} per locale that yields a playable
   * HLS (VidStreaming) server. `sub` yields the single Japanese/original server; `dub` fans out
   * over every dub locale (in practice English — other dub locales are usually BirdStream/DASH
   * only and are skipped, not thrown). The array is ordered so the requested type's default
   * (index 0 == the singular method's pick) is first, and each result is tagged with
   * `serverName` = the locale's display name. Additive: the AnimeParser-interface
   * {@link fetchEpisodeSources} is unchanged.
   *
   * @param episodeId `"<showSlug>::<epNumber>::<locales>"`
   * @param subOrDub `sub` (default) or `dub`
   */
  fetchEpisodeSourcesAll = async (episodeId: string, subOrDub: 'sub' | 'dub' = 'sub'): Promise<ISource[]> => {
    const { showSlug, epNumber, locales } = this.parseEpisodeId(episodeId);
    const targets = this.targetLocales(locales, subOrDub);
    if (targets.length === 0) throw new Error('no audio locales available for episode');

    const settled = await Promise.allSettled(targets.map(loc => this.resolveLocale(showSlug, epNumber, loc)));

    const out: ISource[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(`[KickAssAnime] locale "${targets[i]}" failed: ${(r.reason as Error)?.message ?? r.reason}`);
        return;
      }
      out.push(this.toSource(r.value));
    });
    if (out.length === 0) throw new Error('all audio locales failed to resolve');
    return out;
  };

  /**
   * @param episodeId `"<showSlug>::<epNumber>::<locales>"`
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    const { showSlug, epNumber, locales } = this.parseEpisodeId(episodeId);
    const eps = locales.length ? locales : ['ja-JP'];
    return eps.map(loc => ({
      name: `${this.localeName(loc)} (${loc === 'ja-JP' ? 'sub' : 'dub'})`,
      url: `${this.apiUrl}/show/${showSlug}/episodes?ep=${epNumber}&lang=${loc}`,
    }));
  };

  /** walk every page of the show's episode list into one flat, absolutely-numbered list */
  private parseEpisodeList = async (slug: string, locales: string[]): Promise<IAnimeEpisode[]> => {
    const listLocale = locales.includes('ja-JP') ? 'ja-JP' : locales[0] ?? 'ja-JP';
    const localePart = locales.join(',');
    // first page also returns the `pages` map (all episode-number ranges)
    const first = await this.fetchEpisodesPage(slug, 1, listLocale);
    const pages: any[] = first?.pages ?? [];
    const byNumber = new Map<number, any>();
    for (const e of first?.result ?? []) if (e?.episode_number != null) byNumber.set(e.episode_number, e);

    // fetch the remaining pages (page 1 already loaded above)
    const rest = pages
      .filter(p => Number(p?.from) > 100)
      .map(p => this.fetchEpisodesPage(slug, Number(p.from), listLocale));
    for (const pg of await Promise.all(rest)) {
      for (const e of pg?.result ?? []) if (e?.episode_number != null) byNumber.set(e.episode_number, e);
    }

    return [...byNumber.values()]
      .sort((a, b) => a.episode_number - b.episode_number)
      .map(e => ({
        id: `${slug}::${e.episode_number}::${localePart}`,
        number: e.episode_number,
        title: e.title || `Episode ${e.episode_number}`,
        url: `${this.baseUrl}/${slug}/ep-${e.episode_number}-${e.slug}`,
      }));
  };

  private fetchEpisodesPage = async (slug: string, ep: number, lang: string): Promise<any> => {
    const { data } = await this.client.get(`${this.apiUrl}/show/${slug}/episodes`, {
      params: { ep, lang },
      headers: this.apiHeaders,
    });
    return data;
  };

  private parseEpisodeId = (episodeId: string): { showSlug: string; epNumber: number; locales: string[] } => {
    const [showSlug, num, localePart] = episodeId.split('::');
    const locales = (localePart ?? '').split(',').map(l => l.trim()).filter(Boolean);
    return { showSlug, epNumber: Number(num) || 1, locales };
  };

  /** the audio locales to expose for a `subOrDub` request: `ja-JP` for sub, everything else for
   * dub. English is put first for dub (the reliably-HLS dub); empty falls back to a default set. */
  private targetLocales = (locales: string[], subOrDub: 'sub' | 'dub'): string[] => {
    const all = locales.length ? locales : ['ja-JP', 'en-US'];
    const wanted = subOrDub === 'dub' ? all.filter(l => l !== 'ja-JP') : all.filter(l => l === 'ja-JP');
    const pool = wanted.length ? wanted : subOrDub === 'dub' ? all.filter(l => l !== 'ja-JP') : ['ja-JP'];
    const first = subOrDub === 'dub' ? 'en-US' : 'ja-JP';
    return pool.includes(first) ? [first, ...pool.filter(l => l !== first)] : pool;
  };

  /** resolve one audio locale for an episode into a playable VidStreaming (HLS) stream */
  private resolveLocale = async (showSlug: string, epNumber: number, locale: string): Promise<KaaSource> => {
    // 1) per-locale episode slug
    const page = await this.fetchEpisodesPage(showSlug, epNumber, locale);
    const ep = (page?.result ?? []).find((e: any) => e?.episode_number === epNumber) ?? (page?.result ?? [])[0];
    if (!ep?.slug) throw new Error(`no ${locale} episode for ep ${epNumber}`);

    // 2) episode detail → the VidStreaming (HLS) server
    const { data: detail } = await this.client.get(
      `${this.apiUrl}/show/${showSlug}/episode/ep-${epNumber}-${ep.slug}`,
      { headers: this.apiHeaders }
    );
    const servers: any[] = detail?.servers ?? [];
    const vid = servers.find(s => /vidstream/i.test(s?.src ?? '') || s?.name === 'VidStreaming');
    if (!vid?.src) throw new Error(`no VidStreaming (HLS) server for ${locale} (likely DASH-only)`);

    // 3) player id → HLS master; player page → soft subtitles
    const id = (vid.src.match(/[?&]id=([^&]+)/) ?? [])[1];
    if (!id) throw new Error(`no player id in VidStreaming src for ${locale}`);
    const master = `${KickAssAnime.HLS_BASE}/${id}/master.m3u8`;
    const subtitles = await this.parsePlayerSubtitles(vid.src);

    const isOriginal = locale === 'ja-JP';
    return {
      master,
      locale,
      // force the dub's audio group to default; the original's Japanese track is already default
      audioDefault: isOriginal ? undefined : KickAssAnime.AUDIO_CODES[locale] ?? 'eng',
      subtitles,
    };
  };

  /** pull the English `.vtt` soft-sub track(s) out of the VidStreaming player's island props */
  private parsePlayerSubtitles = async (playerUrl: string): Promise<ISubtitle[]> => {
    try {
      const { data } = await this.client.get(playerUrl, {
        headers: { 'User-Agent': USER_AGENT, Referer: `${this.baseUrl}/` },
      });
      const html = String(data);
      const subtitles: ISubtitle[] = [];
      const seen = new Set<string>();
      // props JSON is HTML-escaped; match the devalue-style `"src":[0,"…vtt"]` alongside a name
      const re = /"language":\[0,"([^"]*)"\],"name":\[0,"([^"]*)"\],"src":\[0,"([^"]+\.vtt)"\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html.replace(/&quot;/g, '"'))) !== null) {
        const url = m[3];
        if (seen.has(url)) continue;
        seen.add(url);
        subtitles.push({ url, lang: m[2] || m[1] || 'English' });
      }
      return subtitles;
    } catch {
      return [];
    }
  };

  private toSource = (s: KaaSource): ISource => ({
    // Referer + Origin the krussdomi CDN requires (segments 403 without Origin); the proxy
    // injects these and, when `audioDefault` is set, marks that audio group DEFAULT in the master.
    headers: { Referer: `${KickAssAnime.PLAYER_ORIGIN}/`, Origin: KickAssAnime.PLAYER_ORIGIN },
    sources: [{ url: s.master, quality: 'auto', isM3U8: true }],
    subtitles: s.subtitles,
    serverName: this.localeName(s.locale),
    ...(s.audioDefault ? { audioDefault: s.audioDefault } : {}),
  });
}

export default KickAssAnime;
