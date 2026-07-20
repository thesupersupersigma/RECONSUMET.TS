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
  ITitle,
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

/**
 * The AllAnime "client-crypto" state, scraped from the live frontend. Protected GraphQL ops are
 * signed with it, and their `tobeparsed` responses are encrypted under the same key.
 *
 * Every field rotates, which is why none of them can be hardcoded:
 * - `key` — `partB` (per **build**, from the homepage's `window.__aaCrypto`) XOR `mask` (per build,
 *   from that build's JS bundle). The two co-rotate, so a mismatched pair yields a dead key.
 * - `epoch` / `switchAt` — the server-side key epoch and the instant it rolls (every `epochMs`,
 *   currently 3 days, with a 24h `graceMs` overlap).
 * - `buildId` — sent as `x-build-id` and bound into the token's IV.
 */
interface AaCryptoState {
  /** 32-byte AES-256-GCM key: signs `aaReq` and decrypts the `tobeparsed` envelope. */
  key: Buffer;
  /** current server key epoch (bound into the token payload and IV). */
  epoch: number;
  /** frontend build id (sent as `x-build-id`, bound into the IV). */
  buildId: string;
  /** epoch-ms at which `epoch` rolls; past this the state must be re-scraped. */
  switchAt: number;
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
 *   ({@link EPISODE_QUERY_HASH}).
 * - **Per-request signing token (`extensions.aaReq`).** Protected ops additionally require a token
 *   proving the caller knows the current epoch key; without it the server answers `HTTP 200` with
 *   `errors:[{message:"AA_CRYPTO_MISSING"}]` and `data.episode: null`. See {@link aaReq} for the
 *   construction and {@link AaCryptoState} for where the key comes from.
 * - **AES-256-GCM response envelope.** Protected responses arrive as `data.tobeparsed` — base64 of
 *   `version(1) ‖ iv(12) ‖ ciphertext ‖ gcmTag(16)`, AES-256-GCM under the **derived epoch key**
 *   (the same key that signs `aaReq`). {@link decryptEnvelope} unwraps it. The old static
 *   `sha256("Xot36i3lK3:v1")` fallback key is dead — it now fails GCM authentication outright.
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
  /** quantum the signing token's `ts` is floored to (client: `xm = 5*6e4`). */
  private static readonly TS_QUANTUM_MS = 5 * 60_000;
  /** attempts for a protected op before giving up (covers epoch rotation, APQ eviction, throttling). */
  private static readonly MAX_PROTECTED_ATTEMPTS = 4;
  /** first backoff step for a retryable protected-op failure; doubles per attempt. */
  private static readonly RETRY_BASE_MS = 2500;
  /** GraphQL error codes meaning "your signing token is missing/expired//wrong build" → re-derive and retry. */
  private static readonly AA_CRYPTO_CODES = [
    'AA_CRYPTO_MISSING',
    'AA_CRYPTO_EXPIRED',
    'AA_CRYPTO_STALE',
    'AA_CRYPTO_BUILD_MISMATCH',
    'AA_CRYPTO_QUERY_MISMATCH',
  ];
  /** sha256 of the exact registered `episode` query text (persisted-query id). */
  private static readonly EPISODE_QUERY_HASH =
    'd405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec';

  /**
   * inline (unprotected) search query.
   *
   * NOTE: `name` alone is NOT enough for the aggregator to match on. AllAnime's `name` is the
   * romaji/native-style title and is sometimes outright obfuscated — the canonical One Piece show
   * (`ReooPAxPMsHM4KPMY`) is literally named `"1P"`, which scores **0.000** against every AniList
   * title and is therefore dropped below the aggregator's TITLE_FLOOR. The schema also exposes
   * `englishName`, `nativeName`, `altNames` and — decisively — **`aniListId`**, so we request all of
   * them: the English title is what the aggregator's `pickTitle` prefers, and `aniListId` gives an
   * exact, fuzz-free mapping key (surfaced as `alID` on the info object, which the aggregator's
   * Tier-2 `verifyMatch` treats as definitive).
   */
  private static readonly SEARCH_QUERY =
    'query($search: SearchInput, $limit: Int, $page: Int, $translationType: VaildTranslationTypeEnumType, $countryOrigin: VaildCountryOriginEnumType) { shows(search: $search, limit: $limit, page: $page, translationType: $translationType, countryOrigin: $countryOrigin) { edges { _id name englishName nativeName altNames aniListId malId availableEpisodes thumbnail } } }';
  /** inline (unprotected) show/episodes query. */
  private static readonly SHOW_QUERY =
    'query ($showId: String!) { show(_id: $showId) { _id name englishName nativeName altNames aniListId malId thumbnail availableEpisodesDetail } }';

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

  /** last resolved client-crypto state (see {@link aaCrypto}); null until first use / after a reset. */
  private aaState: AaCryptoState | null = null;
  /** in-flight resolution, so concurrent first-hits share one homepage+bundle scrape. */
  private aaInflight: Promise<AaCryptoState> | null = null;

  constructor(customBaseURL?: string, proxy?: ProxyConfig, adapter?: AxiosAdapter) {
    super(...arguments);
    if (customBaseURL) {
      this.baseUrl = customBaseURL.startsWith('http') ? customBaseURL : `https://${customBaseURL}`;
    }
    if (proxy) this.setProxy(proxy);
    if (adapter) this.setAxiosAdapter(adapter);
  }

  /**
   * Resolve (and cache) the client-crypto state needed to sign protected ops — see
   * {@link AaCryptoState}. Scraped from the **live frontend**, never hardcoded: `partB` rotates per
   * build and the `epoch` rotates every `epochMs` (currently 3 days), so any constant baked in here
   * goes stale within days. That is exactly how this provider broke — it shipped `buildId: '23'`
   * against an epoch whose `switchAt` passed on 2026-07-12.
   *
   * Both halves of the key MUST come from the same build, so we take `partB` from the homepage's
   * inline `window.__aaCrypto` and the `mask`/`buildId` from the bundle that same homepage loads —
   * self-consistent by construction, and no build-id guessing (the API's
   * `client-crypto/v1/bootstrap?buildId=` only serves a ~2-build window before 404ing).
   *
   * mkissa.to itself is ungated (plain HTTP, no Cloudflare), so this costs no solver time.
   * @param force re-scrape even if the cached state is still within its `switchAt`
   */
  private aaCrypto = async (force = false): Promise<AaCryptoState> => {
    if (!force && this.aaState && Date.now() < this.aaState.switchAt) return this.aaState;
    if (this.aaInflight) return this.aaInflight;
    this.aaInflight = this.resolveAaCrypto()
      .then(state => (this.aaState = state))
      .finally(() => (this.aaInflight = null));
    return this.aaInflight;
  };

  /** scrape homepage + bundle → the derived signing/envelope key. See {@link aaCrypto}. */
  private resolveAaCrypto = async (): Promise<AaCryptoState> => {
    const get = async (url: string): Promise<string> => (await this.client.get(url, { responseType: 'text' })).data;

    // 1) homepage — the epoch/partB the site is currently signing with.
    const home = await get(`${Mkissa.SITE_REFERER}/`);
    const inline = home.match(/__aaCrypto\s*=\s*(\{[^;<]*\})/)?.[1];
    if (!inline) throw new Error('mkissa homepage exposed no __aaCrypto block (site layout changed?)');
    const boot = JSON.parse(inline) as { epoch: number; switchAt: number; partB: string };
    if (!boot?.partB || typeof boot.epoch !== 'number') throw new Error('__aaCrypto block missing epoch/partB');

    // 2) the bundle that same page loads — the XOR mask + the build id it signs as.
    const appUrl = home.match(/"(https?:\/\/[^"]*_app\/immutable\/entry\/app\.[^"]*\.js)"/)?.[1];
    if (!appUrl) throw new Error('could not locate the SvelteKit app entry on the mkissa homepage');
    const chunkBase = appUrl.slice(0, appUrl.indexOf('/entry/'));
    const app = await get(appUrl);
    const chunks = [...new Set(app.match(/chunks\/[A-Za-z0-9_-]+\.js/g) ?? [])];
    // the pair is emitted adjacently as `<mask64hex>":"" , <ident>=<fn>(n)!=="string"?"<buildId>":""`
    const PAIR = /"([0-9a-f]{64})"\s*:\s*""\s*,\s*\w+\s*=\s*\w+\(\d+\)!=="string"\?"(\d+)":""/;
    let mask: string | undefined;
    let buildId: string | undefined;
    for (const chunk of chunks) {
      const hit = (await get(`${chunkBase}/${chunk}`).catch(() => '')).match(PAIR);
      if (hit) [, mask, buildId] = hit;
      if (mask) break;
    }
    if (!mask || !buildId) throw new Error('could not extract the aa-crypto mask/buildId from the mkissa bundle');

    // 3) key[i] = partB[i] ^ mask[i % mask.length]  (client `Vb()`), 32 bytes.
    const maskBytes = Buffer.from(mask, 'hex');
    const partB = Buffer.from(boot.partB, 'base64');
    if (partB.length < 32) throw new Error('__aaCrypto partB is shorter than the 32-byte key');
    const key = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) key[i] = partB[i] ^ maskBytes[i % maskBytes.length];
    return { key, epoch: boot.epoch, buildId, switchAt: Number(boot.switchAt) || 0 };
  };

  /**
   * Build the `extensions.aaReq` signing token for a persisted-query hash (client `n1()`):
   * `base64( 1 ‖ iv(12) ‖ AES-256-GCM(key, iv, json) ‖ tag(16) )`, where
   * `json = {v,ts,epoch,buildId,qh}` and `iv = sha256("<epoch>:<buildId>:<qh>:<ts>")[0:12]`.
   * `ts` is floored to {@link TS_QUANTUM_MS}, so one token is reusable for that whole bucket.
   */
  private aaReq = async (queryHash: string, force = false): Promise<{ token: string; state: AaCryptoState }> => {
    const state = await this.aaCrypto(force);
    const ts = Math.floor(Date.now() / Mkissa.TS_QUANTUM_MS) * Mkissa.TS_QUANTUM_MS;
    const iv = crypto
      .createHash('sha256')
      .update(`${state.epoch}:${state.buildId}:${queryHash}:${ts}`)
      .digest()
      .subarray(0, 12);
    const cipher = crypto.createCipheriv('aes-256-gcm', state.key, iv);
    const payload = JSON.stringify({ v: 1, ts, epoch: state.epoch, buildId: state.buildId, qh: queryHash });
    const ct = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    return { token: Buffer.concat([Buffer.from([1]), iv, ct, cipher.getAuthTag()]).toString('base64'), state };
  };

  /**
   * GET the AllAnime GraphQL API through the Cloudflare solver, returning the operation's data —
   * transparently decrypting the `tobeparsed` AES-GCM envelope on protected responses.
   *
   * Unlike the original, this **surfaces `body.errors`** instead of returning `body.data` blindly.
   * That silence is what made the aa-crypto breakage invisible: the server was answering `HTTP 200
   * {"errors":[{"message":"AA_CRYPTO_MISSING"}],"data":{"episode":null}}` and the provider read only
   * `.data`, turning an explicit rejection into an empty episode list and a "0 servers" result.
   *
   * @param params `variables` plus either `query` (inline) or `extensions` (persisted hash)
   * @param state the crypto state whose key decrypts a protected response (omit for public ops)
   */
  private apiGet = async (params: Record<string, string>, state?: AaCryptoState): Promise<any> => {
    const url = `${this.baseUrl}/api?${new URLSearchParams(params).toString()}`;
    const res = await this.solver.get(url, {
      Referer: `${Mkissa.SITE_REFERER}/`,
      ...(state ? { 'x-build-id': state.buildId } : {}),
    });
    if (res.status !== 200) throw new Error(`api.allanime.day returned HTTP ${res.status}`);
    const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    const payload = body?.data;
    const errors: any[] = Array.isArray(body?.errors) ? body.errors : [];
    // GraphQL can answer partially — only treat errors as fatal when nothing usable came back.
    const usable = payload && Object.values(payload).some(v => v != null);
    if (errors.length && !usable) {
      const first = errors[0];
      throw new Error(`allanime graphql error: ${first?.extensions?.code ?? first?.message ?? 'unknown'}`);
    }
    if (payload?.tobeparsed) {
      if (!state) throw new Error('received a protected `tobeparsed` envelope without a crypto state');
      return Mkissa.decryptEnvelope(payload.tobeparsed, state.key);
    }
    return payload;
  };

  /**
   * Build an {@link ITitle} from an AllAnime show/edge. `name` is the romaji-style title (and is
   * occasionally obfuscated, e.g. One Piece → `"1P"`), so the English title is carried separately
   * and preferred by title-matching consumers. Empty strings are normalised away so a blank
   * `englishName` can't shadow a good romaji one.
   */
  private static toTitle = (e: any): ITitle => {
    const clean = (v: any): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return {
      english: clean(e?.englishName),
      romaji: clean(e?.name),
      native: clean(e?.nativeName),
    };
  };

  /**
   * decrypt a `tobeparsed` AES-256-GCM envelope → the plain operation data.
   * @param key the **derived** epoch key from {@link AaCryptoState} — the old static
   * `sha256("Xot36i3lK3:v1")` fallback key no longer authenticates and fails GCM outright.
   */
  private static decryptEnvelope = (tobeparsed: string, key: Buffer): any => {
    const raw = Buffer.from(tobeparsed, 'base64');
    if (raw[0] !== 1) throw new Error(`unexpected envelope version ${raw[0]}`);
    const iv = raw.subarray(1, 13);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(13, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
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
            // ITitle object, not a bare string: consumers (the aggregator's `pickTitle`) prefer
            // `english`, which is the title AniList matches against. Falls back to `name` (romaji)
            // when AllAnime has no English title, so behaviour is never worse than before.
            title: Mkissa.toTitle(e),
            url: `${Mkissa.SITE_REFERER}/anime/${e._id}`,
            image: e.thumbnail,
            // extra mapping signals (IAnimeResult carries an index signature). `alID`/`malId` are
            // exact keys; `altNames` is every alias AllAnime knows, for alias-aware matchers.
            ...(e.aniListId ? { alID: String(e.aniListId) } : {}),
            ...(e.malId ? { malId: String(e.malId) } : {}),
            ...(Array.isArray(e.altNames) && e.altNames.length ? { altNames: e.altNames as string[] } : {}),
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
      // English title first (what callers display and match on), romaji as the fallback.
      animeInfo.title = show.englishName || show.name || id;
      // AllAnime stores the AniList id per show — an EXACT mapping key. Surfacing it as `alID`
      // lets the aggregator's Tier-2 `verifyMatch` decide definitively instead of guessing from
      // season ordinals / episode counts. Only set when actually present: `verifyMatch` treats a
      // non-empty `alID` as authoritative, so a null one must stay undefined to allow fallthrough.
      if (show.aniListId) animeInfo.alID = String(show.aniListId);
      if (show.malId) animeInfo.malId = String(show.malId);
      if (Array.isArray(show.altNames) && show.altNames.length) animeInfo.altNames = show.altNames;
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

  /**
   * Run the **protected** `episode` persisted query → the decoded `sourceUrls` list.
   *
   * Protected ops need three things together, and the server rejects the request outright if any is
   * wrong: the registered persisted-query hash, a matching `x-build-id`, and an `extensions.aaReq`
   * signing token derived from the current epoch key ({@link aaReq}). Retries cover the three ways
   * this legitimately fails in steady state:
   * - `AA_CRYPTO_*` — the epoch rotated (every ~3 days) or the site redeployed → re-scrape and retry.
   * - `PERSISTED_QUERY_NOT_FOUND` — the API's APQ cache evicted our hash on that node; it is still
   *   registered, so a plain retry succeeds. (Do **not** "fix" this by changing the hash.)
   * - rate limiting — protected ops throttle at roughly 1 request / 5s and answer bursts with
   *   `INTERNAL_SERVER_ERROR`; back off and retry.
   */
  private fetchSourceUrls = async (episodeId: string, subOrDub: 'sub' | 'dub'): Promise<AllAnimeSourceUrl[]> => {
    const { showId, episodeString } = this.parseEpisodeId(episodeId);
    const variables = JSON.stringify({ showId, translationType: subOrDub, episodeString });

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < Mkissa.MAX_PROTECTED_ATTEMPTS; attempt++) {
      // a failed attempt may have been caused by stale crypto — re-derive from attempt 1 onward.
      const { token, state } = await this.aaReq(Mkissa.EPISODE_QUERY_HASH, attempt > 0);
      try {
        const data = await this.apiGet(
          {
            variables,
            extensions: JSON.stringify({
              persistedQuery: { version: 1, sha256Hash: Mkissa.EPISODE_QUERY_HASH },
              aaReq: token,
            }),
          },
          state
        );
        return data?.episode?.sourceUrls ?? [];
      } catch (err) {
        lastError = err as Error;
        const message = lastError.message;
        const retryable =
          Mkissa.AA_CRYPTO_CODES.some(code => message.includes(code)) ||
          /PERSISTED_QUERY_NOT_FOUND|INTERNAL_SERVER_ERROR|Too many requests|HTTP 5\d\d/i.test(message);
        if (!retryable || attempt === Mkissa.MAX_PROTECTED_ATTEMPTS - 1) throw lastError;
        // honour an explicit "try again in N seconds", else exponential backoff off the throttle window.
        const askedFor = Number(message.match(/try again in (\d+)/i)?.[1]) * 1000;
        await new Promise(resolve => setTimeout(resolve, askedFor || Mkissa.RETRY_BASE_MS * 2 ** attempt));
      }
    }
    throw lastError ?? new Error('episode query failed');
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
