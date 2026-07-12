import { AxiosAdapter } from 'axios';
import crypto from 'crypto';

import {
  AnimeParser,
  ISearch,
  IAnimeInfo,
  IAnimeResult,
  IAnimeEpisode,
  IEpisodeServer,
  ISource,
  IVideo,
  StreamingServers,
  SubOrSub,
  ProxyConfig,
  VideoExtractor,
} from '../../models';
import { Mp4Upload, StreamWish, StreamSB, Filemoon, Voe, VidMoly } from '../../extractors';
import { CloudflareSolver } from '../../utils/cf-solver';

/** a single playable server for an episode after decode/resolve. */
interface MkissaSource {
  /** friendly server label used as `serverName` (e.g. `Mp4`, `Sw`, `Ss-Hls`) */
  name: string;
  /** the resolved playable stream (direct mp4/HLS) */
  video: IVideo;
  /** headers the CDN needs (e.g. the embed host's Referer) */
  headers: Record<string, string>;
  /** AllAnime priority (higher = better); used to order servers */
  priority: number;
}

/** raw `sourceUrls` element from the decrypted `episode` response. */
interface AllAnimeSourceUrl {
  sourceUrl: string;
  sourceName?: string;
  priority?: number;
  type?: string;
}

/**
 * mkissa.to — a skin of the **AllAnime / AllManga** catalogue. The site itself (`mkissa.to`) is an
 * ungated SvelteKit SPA; the data lives behind **`api.allanime.day`**, which sits behind Cloudflare's
 * **Managed Challenge** — the *same* challenge as {@link AnimePahe}, so it reuses the shared
 * {@link CloudflareSolver} (Byparr) for the `cf_clearance` cookie. (Unlike AnimePahe's pipeline the
 * API answers over HTTP/1.1 too, but the solver's HTTP/2 path works fine.)
 *
 * The API is a GraphQL endpoint hardened with several anti-scrape layers, all reversed from the
 * mkissa client bundle and confirmed live:
 * - **Persisted queries by operation hash.** Public ops (`shows` search, `show` info) accept a plain
 *   inline query, but the source op (`episode`) is *protected*: an inline query makes the resolver
 *   error (`countryOfOrigin`) and returns null. The client only sends `extensions.persistedQuery.
 *   sha256Hash` — the sha256 of the **exact** registered query text (which crucially nests `show{…}`
 *   inside `episode`, the piece a naive query omits). We send that one registered hash
 *   ({@link EPISODE_QUERY_HASH}); no query text, no signing token needed.
 * - **AES-256-GCM response envelope.** Protected responses arrive as `data.tobeparsed` — base64 of
 *   `version(1) ‖ iv(12) ‖ ciphertext ‖ gcmTag(16)`, AES-256-GCM under the static key
 *   `sha256("Xot36i3lK3:v1")` (the client's fallback key; the server uses it for unauthenticated
 *   reads, which is all we need). {@link decryptEnvelope} unwraps it.
 * - **Obfuscated source URLs.** Each `sourceUrls[].sourceUrl` is either a third-party embed
 *   (`https://…`) or an internal link prefixed `--` whose hex bytes are XOR-0x38 (`--` → `/apivtwo/
 *   clock?id=…`). We resolve the embeds — mp4upload/streamwish/streamsb/filemoon/voe/vidmoly all have
 *   extractors in this repo — and rank them by AllAnime's `priority`. (The internal `clock` endpoint
 *   currently 500s server-side, so internal links are skipped in favour of the embeds.)
 *
 * Resolution chain:
 * - Search:   `GET /api?variables=…&query=<shows query>`         → `{data:{shows:{edges:[{_id,name,
 *             availableEpisodes,thumbnail}]}}}`. `_id` is the anime id.
 * - Info:     `GET /api?variables=…&query=<show query>`          → `{show:{name,thumbnail,
 *             availableEpisodesDetail:{sub[],dub[],raw[]}}}` — the episode-number lists per audio.
 * - Sources:  `GET /api?variables=…&extensions=<persistedQuery hash>` (protected) → `tobeparsed` →
 *             `{episode:{sourceUrls:[…]}}`. Episode id is `"<showId>::<episodeString>"`.
 * - Video:    third-party embed (mp4upload → a direct `*.mp4`, streamwish/… → HLS) resolved by the
 *             existing extractor for that host; the source carries the embed host's Referer.
 */
class Mkissa extends AnimeParser {
  override readonly name = 'Mkissa';
  protected override baseUrl = 'https://api.allanime.day';
  protected override logo = 'https://mkissa.to/favicon.ico';
  protected override classPath = 'ANIME.Mkissa';

  /** the frontend origin the API expects as Referer. */
  private static readonly SITE_REFERER = 'https://mkissa.to';
  /** sent by the client on every API call. */
  private static readonly BUILD_ID = '23';
  /** AES-256-GCM key for the `tobeparsed` envelope — static (client fallback key, used for reads). */
  private static readonly ENVELOPE_KEY = crypto.createHash('sha256').update('Xot36i3lK3:v1').digest();
  /** sha256 of the exact registered `episode` query text (persisted-query id). */
  private static readonly EPISODE_QUERY_HASH =
    'd405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec';

  /** inline (unprotected) search query. */
  private static readonly SEARCH_QUERY =
    'query($search: SearchInput, $limit: Int, $page: Int, $translationType: VaildTranslationTypeEnumType, $countryOrigin: VaildCountryOriginEnumType) { shows(search: $search, limit: $limit, page: $page, translationType: $translationType, countryOrigin: $countryOrigin) { edges { _id name availableEpisodes thumbnail } } }';
  /** inline (unprotected) show/episodes query. */
  private static readonly SHOW_QUERY =
    'query ($showId: String!) { show(_id: $showId) { _id name thumbnail availableEpisodesDetail } }';

  /** embed host substring → the extractor that resolves it to a playable stream. */
  private static readonly EMBED_EXTRACTORS: { host: string; referer: string; make: () => VideoExtractor }[] = [
    { host: 'mp4upload', referer: 'https://www.mp4upload.com/', make: () => new Mp4Upload() },
    { host: 'streamwish', referer: 'https://streamwish.to/', make: () => new StreamWish() },
    { host: 'streamsb', referer: 'https://streamsb.net/', make: () => new StreamSB() },
    { host: 'filemoon', referer: 'https://filemoon.sx/', make: () => new Filemoon() },
    { host: 'bysekoze', referer: 'https://filemoon.sx/', make: () => new Filemoon() }, // filemoon mirror
    { host: 'voe', referer: 'https://voe.sx/', make: () => new Voe() },
    { host: 'vidmoly', referer: 'https://vidmoly.to/', make: () => new VidMoly() },
    { host: 'listeamed', referer: 'https://vidmoly.to/', make: () => new VidMoly() }, // vidmoly mirror
  ];

  private readonly solver = new CloudflareSolver();

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  /**
   * GET the AllAnime GraphQL API through the Cloudflare solver, returning the operation's data —
   * transparently decrypting the `tobeparsed` AES-GCM envelope on protected responses.
   * @param params `variables` plus either `query` (inline) or `extensions` (persisted hash)
   */
  private apiGet = async (params: Record<string, string>): Promise<any> => {
    const url = `${this.baseUrl}/api?${new URLSearchParams(params).toString()}`;
    const res = await this.solver.get(url, {
      Referer: `${Mkissa.SITE_REFERER}/`,
      'x-build-id': Mkissa.BUILD_ID,
    });
    if (res.status !== 200) throw new Error(`api.allanime.day returned HTTP ${res.status}`);
    const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    const payload = body?.data;
    if (payload?.tobeparsed) return Mkissa.decryptEnvelope(payload.tobeparsed);
    return payload;
  };

  /** decrypt a `tobeparsed` AES-256-GCM envelope → the plain operation data. */
  private static decryptEnvelope = (tobeparsed: string): any => {
    const raw = Buffer.from(tobeparsed, 'base64');
    if (raw[0] !== 1) throw new Error(`unexpected envelope version ${raw[0]}`);
    const iv = raw.subarray(1, 13);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(13, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', Mkissa.ENVELOPE_KEY, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  };

  /**
   * @param query search query string
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    const searchResult: ISearch<IAnimeResult> = { currentPage: 1, hasNextPage: false, results: [] };
    try {
      const variables = {
        search: { allowAdult: false, allowUnknown: false, query },
        limit: 26,
        page: 1,
        translationType: 'sub',
        countryOrigin: 'ALL',
      };
      const data = await this.apiGet({ variables: JSON.stringify(variables), query: Mkissa.SEARCH_QUERY });
      const edges: any[] = data?.shows?.edges ?? [];
      searchResult.results = edges
        .filter(e => e?._id)
        .map(
          (e): IAnimeResult => ({
            id: String(e._id),
            title: e.name,
            url: `${Mkissa.SITE_REFERER}/anime/${e._id}`,
            image: e.thumbnail,
            // both audio types are common; advertise BOTH and resolve per-episode.
            subOrDub: (e.availableEpisodes?.dub ?? 0) > 0 ? SubOrSub.BOTH : SubOrSub.SUB,
          })
        );
      return searchResult;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param id AllAnime show id (`_id`)
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const animeInfo: IAnimeInfo = { id, title: '', url: `${Mkissa.SITE_REFERER}/anime/${id}`, episodes: [] };
    try {
      const data = await this.apiGet({ variables: JSON.stringify({ showId: id }), query: Mkissa.SHOW_QUERY });
      const show = data?.show ?? {};
      animeInfo.title = show.name || id;
      if (show.thumbnail) animeInfo.image = show.thumbnail;
      const detail = show.availableEpisodesDetail ?? {};
      const hasDub = Array.isArray(detail.dub) && detail.dub.length > 0;
      animeInfo.subOrDub = hasDub ? SubOrSub.BOTH : SubOrSub.SUB;
      animeInfo.episodes = this.buildEpisodeList(id, detail);
      animeInfo.totalEpisodes = animeInfo.episodes.length;
      return animeInfo;
    } catch (err) {
      throw new Error(`Failed to fetch anime info: ${(err as Error).message}`);
    }
  };

  /**
   * @param episodeId `"<showId>::<episodeString>"`
   * @param server reserved (the playable server is whichever embed resolves)
   * @param subOrDub `sub` (default) or `dub`
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server: StreamingServers = StreamingServers.VidStreaming,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    try {
      const candidates = this.orderByPriority(await this.fetchSourceUrls(episodeId, subOrDub));
      for (const candidate of candidates) {
        const resolved = await this.resolveSource(candidate);
        if (resolved) return this.toSource(resolved);
      }
      throw new Error('no embed server resolved to a playable stream');
    } catch (err) {
      throw new Error(`Failed to fetch episode sources: ${(err as Error).message}`);
    }
  };

  /**
   * Multi-server variant of {@link fetchEpisodeSources}: one {@link ISource} per embed server that
   * resolves to a playable stream, ordered by AllAnime's `priority` (best first — index 0 equals the
   * singular method's pick), each tagged with `serverName`. Servers whose host has no extractor, and
   * the internal `clock` links (server-side 500), are skipped. Additive; the interface method is
   * unchanged.
   *
   * @param episodeId `"<showId>::<episodeString>"`
   * @param subOrDub `sub` (default) or `dub`
   */
  fetchEpisodeSourcesAll = async (episodeId: string, subOrDub: 'sub' | 'dub' = 'sub'): Promise<ISource[]> => {
    const candidates = this.orderByPriority(await this.fetchSourceUrls(episodeId, subOrDub));
    const sources: ISource[] = [];
    for (const candidate of candidates) {
      try {
        const resolved = await this.resolveSource(candidate);
        if (resolved) sources.push(this.toSource(resolved));
      } catch {
        /* skip a server that fails to extract; keep the rest */
      }
    }
    if (sources.length === 0) throw new Error('no embed server resolved to a playable stream');
    return sources;
  };

  /**
   * @param episodeId `"<showId>::<episodeString>"`
   * @param subOrDub `sub` (default) or `dub`
   */
  override fetchEpisodeServers = async (
    episodeId: string,
    subOrDub: 'sub' | 'dub' = 'sub'
  ): Promise<IEpisodeServer[]> => {
    const urls = this.orderByPriority(await this.fetchSourceUrls(episodeId, subOrDub));
    return urls.map(u => ({ name: u.sourceName || 'server', url: this.embedUrl(u.sourceUrl) }));
  };

  /** flatten `availableEpisodesDetail` (sub, with dub numbers merged in) into an ascending episode list. */
  private buildEpisodeList = (showId: string, detail: any): IAnimeEpisode[] => {
    const numbers = new Set<string>([...(detail.sub ?? []), ...(detail.dub ?? [])].map(String));
    return [...numbers]
      .map(n => ({
        id: `${showId}::${n}`,
        number: Number(n) || 0,
        title: `Episode ${n}`,
        url: `${Mkissa.SITE_REFERER}/watch/${showId}/${n}`,
      }))
      .sort((a, b) => a.number - b.number);
  };

  private parseEpisodeId = (episodeId: string): { showId: string; episodeString: string } => {
    const [showId, episodeString] = episodeId.split('::');
    return { showId, episodeString: episodeString ?? '1' };
  };

  /** run the protected `episode` persisted query → the decoded `sourceUrls` list. */
  private fetchSourceUrls = async (episodeId: string, subOrDub: 'sub' | 'dub'): Promise<AllAnimeSourceUrl[]> => {
    const { showId, episodeString } = this.parseEpisodeId(episodeId);
    const variables = { showId, translationType: subOrDub, episodeString };
    const extensions = { persistedQuery: { version: 1, sha256Hash: Mkissa.EPISODE_QUERY_HASH } };
    const data = await this.apiGet({
      variables: JSON.stringify(variables),
      extensions: JSON.stringify(extensions),
    });
    return data?.episode?.sourceUrls ?? [];
  };

  /** decode an AllAnime `sourceUrl` to a normal embed URL (internal `--` links → the clock path). */
  private embedUrl = (sourceUrl: string): string => {
    if (!sourceUrl.startsWith('--')) return sourceUrl.startsWith('//') ? `https:${sourceUrl}` : sourceUrl;
    const hex = sourceUrl.slice(2);
    let out = '';
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ 0x38);
    return out;
  };

  /** best server first: highest AllAnime priority, and internal `--` links last (their CDN 500s). */
  private orderByPriority = (urls: AllAnimeSourceUrl[]): AllAnimeSourceUrl[] =>
    [...urls].sort((a, b) => {
      const internal = (u: AllAnimeSourceUrl) => (u.sourceUrl.startsWith('--') ? 1 : 0);
      return internal(a) - internal(b) || (Number(b.priority) || 0) - (Number(a.priority) || 0);
    });

  /** resolve one source to a playable stream via the matching host extractor, or null if unsupported. */
  private resolveSource = async (source: AllAnimeSourceUrl): Promise<MkissaSource | null> => {
    const embed = this.embedUrl(source.sourceUrl);
    if (!/^https?:\/\//i.test(embed)) return null; // internal clock link — unresolved (CDN 500s)
    const match = Mkissa.EMBED_EXTRACTORS.find(e => embed.includes(e.host));
    if (!match) return null;
    // extractors expose `extract` (protected on the abstract base); the concrete ones resolve to IVideo[].
    const extractor = match.make() as unknown as { extract: (url: URL) => Promise<IVideo[]> };
    const videos = await extractor.extract(new URL(embed));
    if (!videos?.length) return null;
    return {
      name: source.sourceName || match.host,
      video: videos[0],
      headers: { Referer: match.referer },
      priority: Number(source.priority) || 0,
    };
  };

  private toSource = (s: MkissaSource): ISource => ({
    headers: s.headers,
    sources: [s.video],
    subtitles: [],
    serverName: s.name,
  });
}

export default Mkissa;
