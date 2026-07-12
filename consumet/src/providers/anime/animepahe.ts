import { AxiosAdapter } from 'axios';
import { load } from 'cheerio';

import {
  AnimeParser,
  ISearch,
  IAnimeInfo,
  IAnimeResult,
  ISource,
  IVideo,
  IAnimeEpisode,
  IEpisodeServer,
  StreamingServers,
  SubOrSub,
  ProxyConfig,
} from '../../models';
import { USER_AGENT } from '../../utils';
import { CloudflareSolver, http2Get } from '../../utils/cf-solver';

/** one `#resolutionMenu` entry on a `/play` page = a single kwik embed at one audio+resolution. */
interface PaheButton {
  /** the `kwik.cx/e/<id>` embed url (`data-src`) */
  src: string;
  /** `jpn` (Japanese audio + burned-in subs = **sub**) or `eng` (English audio = **dub**) */
  audio: string;
  /** vertical resolution as a string, e.g. `1080` (`data-resolution`) */
  resolution: string;
  /** the fansub group that produced the encode, e.g. `HorribleSubs` (`data-fansub`) — used in the label */
  fansub: string;
}

/**
 * AnimePahe (animepahe.pw) — a large-catalogue anime source whose whole origin sits behind
 * **Cloudflare's Managed Challenge** (the Turnstile JS-VM tier): every `animepahe.pw` request —
 * search, releases, the `/play` page — hard-403s a plain axios/curl client. We clear it with
 * {@link CloudflareSolver} (the shared Byparr client): solve the origin once for a `cf_clearance`
 * cookie + its bound User-Agent, cache the pair, and reuse it on ordinary fast HTTP requests,
 * transparently re-solving when Cloudflare rotates the cookie. The **same** solver serves the
 * pending `mkissa.to` provider, which is behind the identical challenge.
 *
 * Resolution chain:
 * - Search:   `GET /api?m=search&q=<q>`                                  → `{data:[{id,title,type,
 *             episodes,status,season,year,score,poster,session}]}`. `session` (a uuid) is the
 *             **anime session** used everywhere downstream; it is this provider's anime id.
 * - Info:     `GET /anime/<animeSession>` (HTML)                         → `og:title`/`og:image`
 *             + `<meta name=description>` for metadata; episodes come from the release API.
 * - Releases: `GET /api?m=release&id=<animeSession>&sort=episode_asc&page=<p>` → paginated
 *             `{last_page,data:[{episode,title,snapshot,duration,session,audio}]}`; `session` is
 *             the **episode session**. Episode id is `"<animeSession>/<episodeSession>"`.
 * - Play:     `GET /play/<animeSession>/<episodeSession>` (HTML)         → a `#resolutionMenu` of
 *             `<button data-src=kwik.cx/e/… data-audio=jpn|eng data-resolution=… data-fansub=…>`.
 *             **Both** audio types live on one play page (sub = `jpn`, dub = `eng`), each at
 *             multiple resolutions — every resolution is a separate kwik embed, i.e. a separate
 *             "server" that {@link fetchEpisodeSourcesAll} fans out over.
 * - Video:    kwik embed page (Referer-gated on `https://animepahe.pw/`, **not** Cloudflare-gated —
 *             no `cf_clearance` needed) carries an eval-packed script whose only `…m3u8` is the
 *             stream. That resolves to a `*.uwucdn.top` HLS **media** playlist (one quality per
 *             embed): standard **AES-128** (`#EXT-X-KEY` with a `mon.key` URL — no custom key
 *             derivation) over `.jpg`-disguised MPEG-TS segments. The whole CDN (master, key,
 *             segments) gates purely on **`Referer: https://kwik.cx/`** (403 without; plain TLS is
 *             fine, no JA3 impersonation). The `/proxy` injects that Referer and already rewrites
 *             `#EXT-X-KEY URI=` through itself, so a compliant player decrypts natively — the
 *             source just carries `headers.Referer = https://kwik.cx/`.
 *
 * Only kwik/uwucdn are un-Cloudflared; nothing here needs `TLS_IMPERSONATE_HOSTS`.
 */
class AnimePahe extends AnimeParser {
  override readonly name = 'AnimePahe';
  protected override baseUrl = 'https://animepahe.pw';
  protected override logo = 'https://animepahe.pw/pikacon.ico';
  protected override classPath = 'ANIME.AnimePahe';

  /** the exact Referer the kwik embed + its `*.uwucdn.top` CDN require (trailing slash is load-bearing) */
  private static readonly VIDEO_REFERER = 'https://kwik.cx/';
  private static readonly RELEASE_PER_PAGE = 30;

  private readonly solver = new CloudflareSolver();

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  /** browser-like headers Cloudflare's origin expects alongside the cleared cookie/UA. */
  private get siteHeaders() {
    return { Referer: `${this.baseUrl}/`, Accept: 'application/json, text/javascript, */*; q=0.01' };
  }

  /** GET an `animepahe.pw` url through the Cloudflare solver (cached cookie+UA, auto re-solve on 403). */
  private paheGet = async (url: string): Promise<any> => {
    const res = await this.solver.get(url, this.siteHeaders);
    if (res.status !== 200) throw new Error(`animepahe.pw returned HTTP ${res.status} for ${url}`);
    return res.data;
  };

  /**
   * @param query search query string
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    const searchResult: ISearch<IAnimeResult> = { currentPage: 1, hasNextPage: false, results: [] };
    try {
      const data = await this.paheGet(`${this.baseUrl}/api?m=search&q=${encodeURIComponent(query)}`);
      const items: any[] = data?.data ?? [];
      searchResult.results = items
        .filter(i => i?.session)
        .map(
          (item): IAnimeResult => ({
            id: String(item.session), // the anime session is the id used by info/releases
            title: item.title,
            url: `${this.baseUrl}/anime/${item.session}`,
            image: item.poster,
            rating: item.score,
            releaseDate: item.year ? String(item.year) : undefined,
            type: item.type,
            // a play page carries whichever audio types the episode has; both are common, so
            // advertise BOTH and resolve the truth per-episode in fetchEpisodeSources.
            subOrDub: SubOrSub.BOTH,
          })
        );
      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id anime session (uuid) — e.g. the `id` returned by {@link search}
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const animeInfo: IAnimeInfo = { id, title: '', url: `${this.baseUrl}/anime/${id}`, episodes: [] };
    try {
      const html = await this.paheGet(`${this.baseUrl}/anime/${id}`);
      const $ = load(html);
      animeInfo.title = $('meta[property="og:title"]').attr('content')?.trim() || $('h1').first().text().trim();
      const image = $('meta[property="og:image"]').attr('content');
      if (image) animeInfo.image = image;
      const description = $('meta[name="description"]').attr('content')?.trim();
      if (description) animeInfo.description = description;
      const genres = $('div.anime-genre ul li a')
        .map((_, el) => $(el).attr('title') || $(el).text())
        .get()
        .filter(Boolean);
      if (genres.length) animeInfo.genres = genres;
      animeInfo.subOrDub = SubOrSub.BOTH;

      animeInfo.episodes = await this.fetchAllEpisodes(id);
      animeInfo.totalEpisodes = animeInfo.episodes.length;
      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId `"<animeSession>/<episodeSession>"`
   * @param server reserved (AnimePahe's only host is the kwik embed)
   * @param subOrDub `sub` (Japanese audio, default) or `dub` (English audio)
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const buttons = this.selectButtons(await this.parsePlayButtons(episodeId), subOrDub);
      if (buttons.length === 0) throw new Error('no playable servers returned for episode');
      return await this.resolveSource(buttons[0]);
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * Multi-server variant of {@link fetchEpisodeSources}: one {@link ISource} per kwik embed of the
   * requested audio type — i.e. every resolution (1080/720/360p) as a separate resolved HLS stream
   * tagged with `serverName` (e.g. `1080p · Kametsu`, `720p · Dub · Kametsu`), highest quality
   * first, so index 0 equals the singular method's pick. If the requested audio isn't present the
   * other audio's resolutions are returned instead (graceful sub-only/dub-only). Embeds are
   * unpacked **sequentially** — kwik rate-limits a parallel burst — and any that fail to unpack are
   * dropped rather than failing the batch. Additive; the AnimeParser interface method is unchanged.
   *
   * @param episodeId `"<animeSession>/<episodeSession>"`
   * @param subOrDub `sub` (default) or `dub`
   */
  fetchEpisodeSourcesAll = async (episodeId: string, subOrDub: 'sub' | 'dub' = 'sub'): Promise<ISource[]> => {
    const buttons = this.selectButtons(await this.parsePlayButtons(episodeId), subOrDub);
    if (buttons.length === 0) throw new Error('no playable servers returned for episode');
    const sources: ISource[] = [];
    for (const button of buttons) {
      try {
        sources.push(await this.resolveSource(button));
      } catch {
        /* skip an embed that fails to unpack; keep the rest */
      }
    }
    if (sources.length === 0) throw new Error('every kwik embed failed to resolve for episode');
    return sources;
  };

  /**
   * @param episodeId `"<animeSession>/<episodeSession>"`
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    const buttons = await this.parsePlayButtons(episodeId);
    return buttons.map(b => ({ name: this.serverLabel(b), url: b.src }));
  };

  /** paginate the release API into one flat, ascending episode list. */
  private fetchAllEpisodes = async (animeSession: string): Promise<IAnimeEpisode[]> => {
    const first = await this.fetchReleasePage(animeSession, 1);
    const episodes = [...first.episodes];
    for (let page = 2; page <= first.lastPage; page++) {
      episodes.push(...(await this.fetchReleasePage(animeSession, page)).episodes);
    }
    return episodes.sort((a, b) => (a.number || 0) - (b.number || 0));
  };

  private fetchReleasePage = async (
    animeSession: string,
    page: number
  ): Promise<{ lastPage: number; episodes: IAnimeEpisode[] }> => {
    const data = await this.paheGet(
      `${this.baseUrl}/api?m=release&id=${animeSession}&sort=episode_asc&page=${page}`
    );
    const raw: any[] = data?.data ?? [];
    const episodes = raw.map(
      (item): IAnimeEpisode => ({
        id: `${animeSession}/${item.session}`,
        number: Number(item.episode) || 0,
        title: item.title || `Episode ${item.episode}`,
        image: item.snapshot,
        duration: item.duration,
        url: `${this.baseUrl}/play/${animeSession}/${item.session}`,
      })
    );
    return { lastPage: Number(data?.last_page) || 1, episodes };
  };

  /** fetch a `/play` page and read its `#resolutionMenu` kwik embeds. */
  private parsePlayButtons = async (episodeId: string): Promise<PaheButton[]> => {
    const html = await this.paheGet(`${this.baseUrl}/play/${episodeId}`);
    const $ = load(html);
    const buttons: PaheButton[] = [];
    $('#resolutionMenu button[data-src]').each((_, el) => {
      const src = $(el).attr('data-src');
      if (!src) return;
      buttons.push({
        src,
        audio: ($(el).attr('data-audio') || 'jpn').toLowerCase(),
        resolution: $(el).attr('data-resolution') || '',
        fansub: $(el).attr('data-fansub') || '',
      });
    });
    return buttons;
  };

  /**
   * The embeds to serve for the requested audio, highest resolution first. AnimePahe maps audio →
   * sub/dub as `jpn` = **sub**, `eng` = **dub**; when the requested type is absent (sub-only or
   * dub-only episode) we fall back to whatever audio the episode does have, so playback still works.
   */
  private selectButtons = (buttons: PaheButton[], subOrDub: 'sub' | 'dub'): PaheButton[] => {
    const want = subOrDub === 'dub' ? 'eng' : 'jpn';
    const byResDesc = (a: PaheButton, b: PaheButton) => (Number(b.resolution) || 0) - (Number(a.resolution) || 0);
    const preferred = buttons.filter(b => b.audio === want).sort(byResDesc);
    return preferred.length ? preferred : [...buttons].sort(byResDesc);
  };

  /** unpack a kwik embed to its HLS media playlist and wrap it as an {@link ISource}. */
  private resolveSource = async (button: PaheButton): Promise<ISource> => {
    const master = await this.unpackKwik(button.src);
    const video: IVideo = { url: master, quality: this.qualityLabel(button), isM3U8: master.includes('.m3u8') };
    return {
      // the `*.uwucdn.top` CDN 403s without this exact Referer; the /proxy injects it and rewrites
      // the standard AES-128 `#EXT-X-KEY URI=` through itself, so decryption is handled natively.
      headers: { Referer: AnimePahe.VIDEO_REFERER },
      sources: [video],
      subtitles: [], // sub encodes carry burned-in subtitles — there are no separate soft-sub tracks
      serverName: this.serverLabel(button),
    };
  };

  /**
   * Resolve a `kwik.cx/e/<id>` embed to its `.m3u8`. The embed page is Referer-gated on
   * `https://animepahe.pw/` (NOT `cf_clearance`-gated — no cookie needed) but, like the rest of the
   * pipeline, answers **only over HTTP/2** (it 403s HTTP/1.1), so it goes through {@link http2Get}
   * rather than the axios `this.client`. It hides the stream in an eval-packed script whose sole
   * `…m3u8` match is the playlist. (The shared {@link Kwik} extractor can't be reused: it is
   * HTTP/1.1 and hard-codes an `animepahe.com` Referer that now 403s.)
   */
  private unpackKwik = async (embedUrl: string): Promise<string> => {
    const { status, data } = await http2Get(embedUrl, { referer: `${this.baseUrl}/`, 'user-agent': USER_AGENT });
    if (status !== 200) throw new Error(`kwik embed returned HTTP ${status}: ${embedUrl}`);
    const packed = /(eval)(\(f.*?)(\n<\/script>)/s.exec(data);
    if (!packed) throw new Error(`kwik embed had no packed player script: ${embedUrl}`);
    // eslint-disable-next-line no-eval -- the packer is a self-contained P.A.C.K.E.R string; running
    // it yields the deobfuscated player source (same technique as the shared Kwik extractor).
    const unpacked: string = eval(packed[2].replace('eval', ''));
    const m3u8 = unpacked.match(/https?:\/\/[^"'\s]+?\.m3u8/);
    if (!m3u8) throw new Error(`no m3u8 found in kwik embed: ${embedUrl}`);
    return m3u8[0];
  };

  private qualityLabel = (b: PaheButton): string => (b.resolution ? `${b.resolution}p` : 'default');

  /** human server label, e.g. `1080p · HorribleSubs` or `720p · Dub · Kametsu`. */
  private serverLabel = (b: PaheButton): string =>
    [this.qualityLabel(b), b.audio === 'eng' ? 'Dub' : undefined, b.fansub || undefined]
      .filter(Boolean)
      .join(' · ');
}

export default AnimePahe;
