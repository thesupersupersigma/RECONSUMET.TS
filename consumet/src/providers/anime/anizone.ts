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

/** the single stream server-rendered on an `/anime/<id>/<ep>` page */
interface AniZoneStream {
  /** the final HLS master playlist url (straight off the `<media-player src>`) */
  url: string;
  /** every soft-subtitle `<track>` on the page, English first (`.ass`, on the CDN) */
  subtitles: ISubtitle[];
}

/**
 * AniZone (anizone.to) — a **fully browser-free**, server-rendered site on its own
 * Cloudflare-fronted CDN (`*.vid-cdn.xyz` / `*.xin-cdn.xyz`). Built on Laravel
 * Livewire, but every step we need is in the initial HTML — **no extractor class
 * and no embed resolution**, because the m3u8 sits directly in an attribute.
 *
 * Resolution chain (all plain HTTP):
 * - Search:  `GET /anime?search=<q>`   → anime cards linking `/anime/<id>`; each card's
 *            Alpine `x-data` carries the title (`getTitle(this.anmTitles, '<default>')`).
 * - Info:    `GET /anime/<id>`         → `<title>` = series name; poster is an
 *            `img[src*="/images/anime/"]`.
 * - Episodes:same page → `a[wire:navigate]` links to `/anime/<id>/<ep>` (the plain
 *            "Watch" hero button lacks `wire:navigate`, so it's skipped). Long shows
 *            **paginate** via Livewire — but the page also honours a plain `?page=N`
 *            query (36 eps/page), so we walk pages from the `gotoPage(N)` control max
 *            instead of driving Livewire.
 * - Source:  `GET /anime/<id>/<ep>`    → `<media-player src="…/master.m3u8">` — this IS
 *            the final multi-quality HLS master (360p/720p/1080p + a Japanese audio
 *            group). No dub audio is offered; English comes as **soft subtitle tracks**
 *            (`<track kind="subtitles">`, `.ass`, incl. `English (US)` + `(CC)`), which
 *            we surface in `subtitles[]`.
 *
 * The CDN is **TLS-fingerprint (JA3/JA4) gated** — plain axios/fetch handshakes are reset;
 * only a browser-fingerprinted client (the API `/proxy`'s curl-impersonate path) can pull
 * the manifest/segments. AniZone's own CDN hosts are therefore in the proxy's impersonation
 * list. The scrape itself (the `anizone.to` HTML) is un-gated and works over plain HTTP.
 */
class AniZone extends AnimeParser {
  override readonly name = 'AniZone';
  protected override baseUrl = 'https://anizone.to';
  protected override logo = 'https://anizone.to/favicon.ico';
  protected override classPath = 'ANIME.AniZone';

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  private get pageHeaders() {
    return { Referer: `${this.baseUrl}/`, 'User-Agent': USER_AGENT };
  }

  /** `/anime/<id>` (or full url) → series id (never an episode `/anime/<id>/<ep>`) */
  private idFromUrl = (href: string): string => (href.match(/\/anime\/([^/?#]+)(?:$|[?#])/) ?? [])[1] ?? '';

  /**
   * @param query search query string
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    const searchResult: ISearch<IAnimeResult> = { currentPage: 1, hasNextPage: false, results: [] };
    try {
      const { data } = await this.client.get(`${this.baseUrl}/anime?search=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': USER_AGENT },
      });
      const $ = load(data);

      const seen = new Set<string>();
      $('a[wire\\:navigate][href*="/anime/"]').each((_i, el) => {
        const a = $(el);
        const id = this.idFromUrl(a.attr('href') ?? '');
        if (!id || seen.has(id)) return;
        seen.add(id);
        // the title lives on the card's Alpine `x-data` as the `getTitle(this.anmTitles, '<default>')`
        // default arg (the anchor text itself is Alpine `x-text`, so it's empty in the HTML).
        const card = a.closest('[x-data]');
        const title = ((card.attr('x-data') ?? '').match(/getTitle\(this\.anmTitles,\s*'([^']*)'\)/) ?? [])[1];
        searchResult.results.push({
          id,
          title: (title || id).replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))),
          url: `${this.baseUrl}/anime/${id}`,
          image: card.find('img').first().attr('src'),
          subOrDub: SubOrSub.SUB,
        });
      });

      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id series id, e.g. `mdkytdqp`
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const animeId = this.idFromUrl(id) || id;
    const url = `${this.baseUrl}/anime/${animeId}`;
    const animeInfo: IAnimeInfo = { id: animeId, title: '', url, episodes: [] };

    try {
      const { data } = await this.client.get(url, { headers: this.pageHeaders });
      const $ = load(data);

      animeInfo.title = $('title').text().replace(/\s*[—–-]\s*AniZone\s*$/i, '').trim() || animeId;
      const image = $('img[src*="/images/anime/"]').first().attr('src');
      if (image) animeInfo.image = image;

      const episodes = await this.parseEpisodeList(animeId, $);
      animeInfo.episodes = episodes;
      animeInfo.totalEpisodes = episodes.length;

      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId `"<id>/<ep>"`, e.g. `mdkytdqp/1`
   * @param server reserved (AniZone renders exactly one stream per episode page)
   * @param subOrDub reserved — AniZone is subtitle-only (Japanese audio + soft subs), so
   *   there is no dub variant; the single stream is returned either way (see class docs)
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const stream = await this.parseEpisodePage(episodeId);
      return this.toSource(stream);
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * Multi-server variant of {@link fetchEpisodeSources}. AniZone renders **one** HLS stream
   * per episode page (no named servers to fan out over), so this returns a single-element
   * {@link ISource}[] — but it keeps the same array contract as the other multi-server
   * providers so the aggregator/API layer treats every source uniformly. The one result is
   * tagged with `serverName` and carries every soft-subtitle track (English first). Additive:
   * the AnimeParser-interface {@link fetchEpisodeSources} is unchanged.
   *
   * @param episodeId `"<id>/<ep>"`
   * @param subOrDub reserved (subtitle-only site — see {@link fetchEpisodeSources})
   */
  fetchEpisodeSourcesAll = async (episodeId: string, subOrDub: 'sub' | 'dub' = 'sub'): Promise<ISource[]> => {
    const stream = await this.parseEpisodePage(episodeId);
    return [this.toSource(stream)];
  };

  /**
   * @param episodeId `"<id>/<ep>"`
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    const stream = await this.parseEpisodePage(episodeId);
    return [{ name: this.name, url: stream.url }];
  };

  /** shape a parsed episode page into the ISource contract (Referer for parity; CDN is TLS-gated) */
  private toSource = (stream: AniZoneStream): ISource => ({
    headers: { Referer: `${this.baseUrl}/` },
    sources: [{ url: stream.url, quality: 'auto', isM3U8: true }],
    subtitles: stream.subtitles,
    serverName: this.name,
  });

  /**
   * Collect the full episode list. The initial anime page (`$0`, reused if passed) holds the
   * first page of episodes plus the Livewire pager; long shows paginate via `?page=N`
   * (36 eps/page). We read the max page off the `gotoPage(N)` controls and walk the rest.
   */
  private parseEpisodeList = async (animeId: string, $0?: ReturnType<typeof load>): Promise<IAnimeEpisode[]> => {
    const $first = $0 ?? load((await this.client.get(`${this.baseUrl}/anime/${animeId}`, { headers: this.pageHeaders })).data);

    let maxPage = 1;
    $first('[wire\\:click]').each((_i, el) => {
      const m = ($first(el).attr('wire:click') ?? '').match(/gotoPage\((\d+)\)/);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    maxPage = Math.min(maxPage, 500); // safety cap against a pathological pager

    const byNumber = new Map<number, IAnimeEpisode>();
    const harvest = ($: ReturnType<typeof load>) => {
      $(`a[wire\\:navigate][href*="/anime/${animeId}/"]`).each((_i, el) => {
        const href = $(el).attr('href') ?? '';
        const m = href.match(new RegExp(`/anime/${animeId}/([0-9.]+)(?:$|[?#])`));
        if (!m) return; // the plain "Watch" hero button has no wire:navigate and is skipped anyway
        const number = parseFloat(m[1]);
        if (byNumber.has(number)) return;
        byNumber.set(number, {
          id: `${animeId}/${m[1]}`,
          number,
          title: $(el).find('h3').first().text().trim() || `Episode ${number}`,
          url: `${this.baseUrl}/anime/${animeId}/${m[1]}`,
        });
      });
    };

    harvest($first);
    if (maxPage > 1) {
      const rest = await Promise.all(
        Array.from({ length: maxPage - 1 }, (_v, i) =>
          this.client
            .get(`${this.baseUrl}/anime/${animeId}?page=${i + 2}`, { headers: this.pageHeaders })
            .then(r => load(r.data))
        )
      );
      rest.forEach(harvest);
    }

    return [...byNumber.values()].sort((a, b) => a.number - b.number);
  };

  /** `/anime/<id>/<ep>` → the `<media-player src>` HLS master + its soft-subtitle tracks */
  private parseEpisodePage = async (episodeId: string): Promise<AniZoneStream> => {
    const path = episodeId.startsWith('http') ? episodeId : `${this.baseUrl}/anime/${episodeId}`;
    const { data } = await this.client.get(path, { headers: this.pageHeaders });
    const $ = load(data);

    const url = $('media-player').attr('src');
    if (!url || !url.includes('.m3u8')) throw new Error(`no media-player m3u8 found for ${episodeId}`);

    // soft subtitles ride as vidstack `<track kind="subtitles">` (`.ass`, on the CDN). Keep
    // every language but float English to the front so index 0 is the common default.
    const subtitles: ISubtitle[] = [];
    $('track[kind="subtitles"]').each((_i, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      subtitles.push({ url: src, lang: $(el).attr('label') || $(el).attr('srclang') || 'Unknown' });
    });
    subtitles.sort((a, b) => Number(/^en/i.test(b.lang)) - Number(/^en/i.test(a.lang)));

    return { url, subtitles };
  };
}

export default AniZone;
