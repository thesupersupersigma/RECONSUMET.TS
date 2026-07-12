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

/** one audio-locale server resolved for an episode via the media endpoint */
interface UniqueStreamSource {
  /** the signed HLS master playlist url (short-TTL — resolved fresh, never cached) */
  master: string;
  /** resolved audio locale, e.g. `ja-JP`, `en-US` */
  locale: string;
  /** true for the original Japanese audio (the "sub" experience) */
  original: boolean;
  /** soft subtitle tracks, if the media response ships any */
  subtitles: ISubtitle[];
  /** media response `media_id` — the proxy needs it to derive the real HLS key from the
   * `key.bin` response (see {@link ISource.keyMediaId}) */
  mediaId?: string;
}

/**
 * UniqueStream (anime.uniquestream.net) — a **self-hosted** Crunchyroll re-host: it drives real
 * CR accounts, pulls the streams and re-serves them from its own `*.mediacache.cc` CDN behind
 * signed, short-TTL URLs. From our side it behaves like an independent host (no CR creds, own
 * API, own CDN). The backend is a **fully self-documented FastAPI** (203-endpoint OpenAPI at
 * `/api/v1/openapi.json`) — request/response shapes below are taken straight from it.
 *
 * Genuinely multi-server: each episode exposes one server **per audio locale** — `ja-JP`
 * (original = **sub**) plus every dub locale (`en-US`, `es-419`, `pt-BR`, …) — which is what
 * {@link fetchEpisodeSourcesAll} fans out over.
 *
 * Resolution chain (plain HTTP JSON — the API is **not** gated):
 * - Search:   `GET /api/v1/search?query=<q>`                → `{series,movies,episodes}` catalog
 *             items (NOTE: the param is `query`, not `q` — `q` silently returns nothing).
 * - Series:   `GET /api/v1/series/<contentId>`              → `{title,description,images,seasons,
 *             audio_locales}`.
 * - Episodes: `GET /api/v1/season/<seasonId>/episodes?page=&limit=` → per-season episode list,
 *             each with its own `audio_locales`.
 * - Media:    `GET /api/v1/episode/<contentId>/media/hls/<locale>` → `{hls:{playlist,hard_subs,
 *             subtitles,locale,original}}`. **Requires `x-real-ip` + `user-agent` headers**
 *             (region resolution). `playlist` is a real signed master.m3u8. The original (sub)
 *             audio ships **no** in-manifest subs, so for it we serve the English `hard_subs`
 *             playlist (Japanese audio + burned-in English subs); dub audio needs no subs.
 * - Video:    the signed master is real HLS (1080p + AAC). Segments use a `.png` extension
 *             (image/png-disguised MPEG-TS, like AniDB's `.xls`) **and are AES-128 encrypted
 *             with a bespoke key**: the playlist's `#EXT-X-KEY` points at a `key.bin` that
 *             serves base64 *ciphertext* (not a raw 16-byte key). The player recovers the real
 *             key by AES-128-CBC-decrypting that body with `sha256("key"+media_id)[:16]` /
 *             `sha256("iv"+media_id)[:16]`, having first sent the `media_id` as the
 *             `x-am-media-id` request header (the CDN encrypts key.bin against it). We surface
 *             `media_id` on the source as {@link ISource.keyMediaId} so the `/proxy` reproduces
 *             this transform; segments then decrypt with a standard HLS AES-128 engine. The URLs
 *             are short-TTL signed, so we always resolve fresh at request time (never cache them).
 */
class UniqueStream extends AnimeParser {
  override readonly name = 'UniqueStream';
  protected override baseUrl = 'https://anime.uniquestream.net';
  protected override logo = 'https://anime.uniquestream.net/favicon.ico';
  protected override classPath = 'ANIME.UniqueStream';

  private get apiUrl(): string {
    return `${this.baseUrl}/api/v1`;
  }

  /** CR audio/subtitle locale → display name (falls back to the raw code) */
  private static readonly LOCALE_NAMES: Record<string, string> = {
    'ja-JP': 'Japanese',
    'en-US': 'English',
    'es-419': 'Spanish (LatAm)',
    'es-ES': 'Spanish (Spain)',
    'pt-BR': 'Portuguese (Brazil)',
    'pt-PT': 'Portuguese (Portugal)',
    'fr-FR': 'French',
    'de-DE': 'German',
    'it-IT': 'Italian',
    'ar-SA': 'Arabic',
    'ru-RU': 'Russian',
    'hi-IN': 'Hindi',
    'ta-IN': 'Tamil',
    'te-IN': 'Telugu',
    'ko-KR': 'Korean',
    'zh-CN': 'Chinese (Mandarin)',
    'zh-HK': 'Chinese (Cantonese)',
    'zh-TW': 'Chinese (Taiwan)',
    'th-TH': 'Thai',
    'pl-PL': 'Polish',
    'id-ID': 'Indonesian',
    'ms-MY': 'Malay',
    'vi-VN': 'Vietnamese',
  };

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  /** headers the media endpoint requires for region resolution (`x-real-ip` value is not
   * load-bearing to which locale resolves, but the endpoint documents it as required) */
  private get mediaHeaders() {
    return {
      'user-agent': USER_AGENT,
      'x-real-ip': process.env.UNIQUESTREAM_X_REAL_IP || '8.8.8.8',
    };
  }

  private localeName = (locale: string): string => UniqueStream.LOCALE_NAMES[locale] ?? locale;

  private toResult = (item: any): IAnimeResult => ({
    id: item.content_id,
    title: item.title,
    url: `${this.baseUrl}/series/${item.content_id}`,
    image: item.image,
    subOrDub:
      item.subbed && item.dubbed ? SubOrSub.BOTH : item.dubbed ? SubOrSub.DUB : SubOrSub.SUB,
    type: item.type,
  });

  /**
   * @param query search query string
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    const searchResult: ISearch<IAnimeResult> = { currentPage: 1, hasNextPage: false, results: [] };
    try {
      const { data } = await this.client.get(`${this.apiUrl}/search`, {
        params: { query },
        headers: { 'User-Agent': USER_AGENT },
      });
      const items: any[] = [...(data?.series ?? []), ...(data?.movies ?? [])];
      searchResult.results = items.filter(i => i?.content_id).map(this.toResult);
      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id series content id, e.g. `1KhaSDCP`
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const animeInfo: IAnimeInfo = { id, title: '', url: `${this.baseUrl}/series/${id}`, episodes: [] };
    try {
      const { data } = await this.client.get(`${this.apiUrl}/series/${id}`, {
        headers: { 'User-Agent': USER_AGENT },
      });
      animeInfo.title = data?.title ?? id;
      const image = (data?.images ?? []).find((i: any) => i?.type === 'poster_tall')?.url ?? data?.images?.[0]?.url;
      if (image) animeInfo.image = image;
      if (data?.description) animeInfo.description = data.description;
      if (Array.isArray(data?.genre)) animeInfo.genres = data.genre;

      animeInfo.episodes = await this.parseEpisodeList(data?.seasons ?? []);
      animeInfo.totalEpisodes = animeInfo.episodes.length;
      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId `"<contentId>::<loc1,loc2,...>"` (the audio_locales are carried alongside
   *   the episode content id so the media endpoint can be resolved per-locale without a re-lookup)
   * @param server reserved (UniqueStream's "servers" are the audio locales, resolved below)
   * @param subOrDub `sub` (Japanese/original, default) or `dub` (any non-Japanese audio)
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const { contentId, locales } = this.parseEpisodeId(episodeId);
      const targets = this.targetLocales(locales, subOrDub);
      if (targets.length === 0) throw new Error('no audio locales available for episode');
      return this.toSource(await this.resolveLocale(contentId, targets[0]));
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * Multi-server variant of {@link fetchEpisodeSources}: resolve **every** audio locale of the
   * requested type in parallel and return one {@link ISource} per locale that resolves. Locales
   * that fail (or a dub that isn't ready and falls back to the original) are skipped/deduped, not
   * thrown. `sub` yields the single Japanese/original server; `dub` fans out over every dub
   * locale (English, Spanish, Portuguese, …) — the real multi-element case. The array is ordered
   * so the requested type's default (index 0 == the singular method's pick) is first, and each
   * result is tagged with `serverName` = the locale's display name. Additive: the
   * AnimeParser-interface {@link fetchEpisodeSources} is unchanged.
   *
   * @param episodeId `"<contentId>::<locales>"`
   * @param subOrDub `sub` (default) or `dub`
   */
  fetchEpisodeSourcesAll = async (episodeId: string, subOrDub: 'sub' | 'dub' = 'sub'): Promise<ISource[]> => {
    const { contentId, locales } = this.parseEpisodeId(episodeId);
    const targets = this.targetLocales(locales, subOrDub);
    if (targets.length === 0) throw new Error('no audio locales available for episode');

    const settled = await Promise.allSettled(targets.map(loc => this.resolveLocale(contentId, loc)));

    const out: ISource[] = [];
    const seen = new Set<string>();
    settled.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(`[UniqueStream] locale "${targets[i]}" failed: ${(r.reason as Error)?.message ?? r.reason}`);
        return;
      }
      // dedupe by resolved locale — dubs that aren't ready fall back to the ja-JP original, so
      // several requested dubs can collapse onto the same stream; keep only the first of each.
      if (seen.has(r.value.locale)) return;
      seen.add(r.value.locale);
      out.push(this.toSource(r.value));
    });
    if (out.length === 0) throw new Error('all audio locales failed to resolve');
    return out;
  };

  /**
   * @param episodeId `"<contentId>::<locales>"`
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    const { contentId, locales } = this.parseEpisodeId(episodeId);
    return (locales.length ? locales : ['ja-JP']).map(loc => ({
      name: `${this.localeName(loc)} (${loc === 'ja-JP' ? 'sub' : 'dub'})`,
      url: `${this.apiUrl}/episode/${contentId}/media/hls/${loc}`,
    }));
  };

  /** walk every season's paginated episode list into one flat, absolutely-numbered list */
  private parseEpisodeList = async (seasons: any[]): Promise<IAnimeEpisode[]> => {
    const episodes: IAnimeEpisode[] = [];
    let counter = 0;
    for (const season of seasons) {
      if (!season?.content_id) continue;
      const limit = 20; // API caps `limit` at 20 (per openapi.json)
      for (let page = 1; page <= 500; page++) {
        const { data } = await this.client.get(`${this.apiUrl}/season/${season.content_id}/episodes`, {
          params: { page, limit },
          headers: { 'User-Agent': USER_AGENT },
        });
        const batch: any[] = Array.isArray(data) ? data : data?.episodes ?? data?.items ?? [];
        for (const e of batch) {
          if (!e?.content_id) continue;
          const locales: string[] = e.audio_locales ?? [];
          episodes.push({
            id: `${e.content_id}::${locales.join(',')}`,
            number: ++counter,
            title: e.title || `Episode ${e.episode_number ?? counter}`,
            url: `${this.baseUrl}/watch/${e.content_id}`,
          });
        }
        if (batch.length < limit) break; // last page of this season
      }
    }
    return episodes;
  };

  private parseEpisodeId = (episodeId: string): { contentId: string; locales: string[] } => {
    const [contentId, localePart] = episodeId.split('::');
    const locales = (localePart ?? '').split(',').map(l => l.trim()).filter(Boolean);
    return { contentId, locales };
  };

  /** the audio locales to expose for a `subOrDub` request: `ja-JP` for sub, everything else for
   * dub. Empty locales (or a type with no members) fall back to the sensible default set. */
  private targetLocales = (locales: string[], subOrDub: 'sub' | 'dub'): string[] => {
    const all = locales.length ? locales : ['ja-JP', 'en-US'];
    const wanted = subOrDub === 'dub' ? all.filter(l => l !== 'ja-JP') : all.filter(l => l === 'ja-JP');
    const pool = wanted.length ? wanted : all;
    // put the common default first: English for dub, Japanese for sub.
    const first = subOrDub === 'dub' ? 'en-US' : 'ja-JP';
    return pool.includes(first) ? [first, ...pool.filter(l => l !== first)] : pool;
  };

  /** resolve one audio locale through the media endpoint into a playable stream */
  private resolveLocale = async (contentId: string, locale: string): Promise<UniqueStreamSource> => {
    const { data } = await this.client.get(`${this.apiUrl}/episode/${contentId}/media/hls/${locale}`, {
      headers: this.mediaHeaders,
    });
    const hls = data?.hls;
    if (!hls?.playlist) {
      const reason = data?.coming_soon ? 'coming soon' : data?.hls_not_ready ? 'hls not ready' : 'no playlist';
      throw new Error(`media not available for ${locale} (${reason})`);
    }

    const original = hls.original === true;
    let master: string = hls.playlist;
    // the original (sub) audio ships no in-manifest subtitles — serve the English hard-subbed
    // playlist (Japanese audio + burned-in English subs) so it's actually watchable; dub audio
    // is already in the target language and needs none.
    if (original && Array.isArray(hls.hard_subs) && hls.hard_subs.length) {
      const hs = hls.hard_subs.find((h: any) => /^en/i.test(h?.locale)) ?? hls.hard_subs[0];
      if (hs?.playlist) master = hs.playlist;
    }

    const subtitles: ISubtitle[] = (hls.subtitles ?? [])
      .filter((s: any) => s?.url)
      .map((s: any) => ({ url: s.url, lang: this.localeName(s.language) }));

    return { master, locale: hls.locale ?? locale, original, subtitles, mediaId: data?.media_id };
  };

  private toSource = (s: UniqueStreamSource): ISource => ({
    headers: { Referer: `${this.baseUrl}/` },
    sources: [{ url: s.master, quality: 'auto', isM3U8: true }],
    subtitles: s.subtitles,
    serverName: this.localeName(s.locale),
    // the mediacache.cc segments are AES-128 with a bespoke `key.bin` (base64 ciphertext,
    // not a raw key); the proxy uses this media_id to derive the real content key.
    ...(s.mediaId ? { keyMediaId: s.mediaId } : {}),
  });
}

export default UniqueStream;
