import { load } from 'cheerio';

import {
  MangaParser,
  ISearch,
  IMangaInfo,
  IMangaResult,
  MediaStatus,
  IMangaChapterPage,
  IMangaChapter,
} from '../../models';
import { MalSyncIndex, MangaAliasResolver } from '../meta/manga-xref';

/**
 * MangaKakalot / MangaNato.
 *
 * HOST HISTORY. This provider used to talk to two hardcoded hosts, and both are gone:
 *   - `mangakakalot.com` now answers Cloudflare 522 on the root and 301s every real path to
 *     `spinzywheel.com`, a wheel-spinner site.
 *   - `readmanganato.com` is parked (ParkLogic).
 * The successor network is mostly behind a Cloudflare interactive challenge (`mangakakalot.gg`,
 * `natomanga.com` and `nelomanga.net` all answer `cf-mitigated: challenge` + 403), but
 * `www.manganato.gg` is NOT challenged and serves the same content to a plain HTTP client.
 *
 * DO NOT send browser-like headers here. This site family's edge rule fires on a browser-claiming
 * User-Agent arriving from a non-browser TLS stack — an honest non-browser UA gets 200 where
 * `Mozilla/5.0...` gets 403. Escalating the disguise makes this provider worse, not better.
 *
 * URL SHAPES on the new host:
 *   detail   `/manga/<slug>`                     e.g. /manga/one-piece
 *   chapter  `/manga/<slug>/<chapter-slug>`      e.g. /manga/one-piece/chapter-1190
 *   chapters `/api/manga/<slug>/chapters`        JSON, paginated — the detail page no longer
 *                                                server-renders its chapter list.
 * A chapter id is therefore `<slug>/<chapter-slug>`. The old code smuggled a `$$READMANGANATO`
 * sentinel through the id field to pick a host; that magic string is gone along with its host.
 *
 * SEARCH: THE SITE HAS A REAL SEARCH API, AND IT IS UNREACHABLE. Do not re-derive this — the full
 * sweep was done on 2026-08-14 and every result is below.
 *
 * The site's own frontend does have a JSON search endpoint. `/` ships `<form name="frmsearch">`
 * plus `/js/fsearch.js`, and that script issues:
 *     GET /home/search/json?searchword=<change_alias(q)>      (jQuery $.ajax, dataType json)
 * where `change_alias` lowercases and maps every space/punctuation run to `_`, i.e.
 * `demon slayer` → `demon_slayer`. It is NOT covered by robots.txt, whose only Disallow rules are
 * the `/search/story/` wildcard, `*?page=*`, `*?filter=*`, `/login` and `/register`.
 *
 * It is still unusable, and unlike `/search/story/` the reason is a MANAGED CHALLENGE, not a WAF
 * block — both search paths answer `HTTP 403` with `cf-mitigated: challenge` and a
 * `Just a moment...` interstitial. Probed, all 403:
 *     GET  /home/search/json?searchword=demon_slayer          UA `Consumet/1.0`      → 403
 *     GET  /home/search/json?searchword=demon_slayer          UA `Mozilla/5.0 …`     → 403
 *     GET  /home/search/json?searchword=demon_slayer          + X-Requested-With     → 403
 *     POST /home/search/json  (form body, ±X-Requested-With)                         → 403
 *     GET  /home/search/json  (no query at all)                                      → 403
 *     GET  /api/home/search/json?searchword=…                                        → 403
 *     …and the same on www.natomanga.com, www.nelomanga.net, www.mangakakalot.gg.
 * The rule is PATH-scoped, not client-scoped: on the very same connection and UA,
 * `/manga/one-piece`, `/api/manga/one-piece/chapters` and `/manga-list/hot-manga` all answer 200.
 * So the UA lever does not open it, no header does, and `/home/search`, `/advanced_search`,
 * `/autocomplete`, `/suggest`, `/api/search` and `/search?q=` are all plain 404 — there is no
 * unguarded sibling. Clearing a managed challenge needs a real browser, which is out of scope here.
 *
 * WHAT SEARCH THEREFORE DOES — two corpora, in this order:
 *   1. A slug index built from the site's own `sitemap.xml` (robots explicitly advertises it):
 *      ~94k slugs across 10 shards. This is the site's catalogue, but keyed by SLUG.
 *   2. An ALIAS BRIDGE (AniList + MAL-Sync, via ../meta/manga-xref) that runs only when the query
 *      is not already an exact slug. A slug encodes exactly ONE title, so the index alone cannot
 *      answer `demon slayer` — and, worse than missing, it used to answer it CONFIDENTLY WRONG
 *      with nine doujinshi/colour-re-release slugs. The bridge turns the query into
 *      externally-attested identities and then confirms each one against this site.
 * See `search()` for the guarantees and the residual limits.
 */

/** How long a built slug index stays usable before it is rebuilt. */
const SEARCH_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
/** Hard ceiling on sitemap shards followed, so a malformed index cannot fan out without bound. */
const MAX_SITEMAP_SHARDS = 20;
/** Hard ceiling on indexed slugs, so the in-memory index cannot grow without bound. */
const MAX_INDEXED_SLUGS = 250_000;
/** Chapters requested per `/api/manga/<slug>/chapters` call. */
const CHAPTER_API_PAGE_SIZE = 500;
/** Ceiling on chapter-API round trips, so a lying `has_more` cannot loop forever. */
const MAX_CHAPTER_API_CALLS = 40;
/** Search results per page. */
const RESULTS_PER_PAGE = 20;

/** AniList alias candidates the bridge is allowed to turn into site slugs. */
const ALIAS_MAX_CANDIDATES = 4;
/**
 * Direct `/manga/<slug>` confirmations the alias bridge may spend per search, for slugs the sitemap
 * index does not list. Bounded on purpose: the index already answers the common case for free, and
 * this exists only so a sitemap that is stale (or unreachable) cannot silently hide a real hit.
 */
const ALIAS_PROBE_BUDGET = 2;
/** Alias titles slugified per candidate. Beyond this it is all non-Latin scripts that slugify away. */
const ALIAS_MAX_TITLES = 12;

/** Browse listings used as a last-resort search corpus when the sitemap index is unavailable. */
const BROWSE_LISTINGS = ['/manga-list/latest-manga', '/manga-list/hot-manga', '/manga-list/new-manga'];

interface ChapterApiEntry {
  chapter_name?: string;
  chapter_slug?: string;
  chapter_num?: number;
  updated_at?: string;
  view?: number;
}

/** How a search result was reached. Present on every result `search()` returns. */
export type MangaKakalotMatchedVia =
  /** the query slugified straight onto a slug in the sitemap index */
  | 'slug-index'
  /** MAL-Sync named this exact slug for the AniList series the query resolved to */
  | 'alias-malsync'
  /** an AniList title/synonym for the resolved series slugified onto a slug on this site */
  | 'alias-anilist-title'
  /** the sitemap was unavailable; the query was probed directly as `/manga/<slug>` */
  | 'slug-probe'
  /** the sitemap was unavailable; scraped off a browse listing */
  | 'browse-listing';

export interface IMangaKakalotResult extends IMangaResult {
  /** true when `title` was de-slugified from the url instead of read off the site. */
  approximateTitle?: boolean;
  matchedVia?: MangaKakalotMatchedVia;
}

/**
 * Why the answer looks the way it does.
 *
 * THIS FIELD IS THE POINT, not decoration. A search that quietly returns `[]` — or, as this
 * provider used to for `demon slayer`, quietly returns nine confident wrong answers — is the
 * silent-degradation shape this repo has been burned by. Every degraded or empty result set
 * carries a populated `warning` here AND is logged, so "no results" can always be told apart from
 * "the sitemap was down" and from "the alias bridge could not reach AniList".
 */
export interface IMangaKakalotSearchDiagnostics {
  /** Corpora that actually contributed, in contribution order. */
  strategy: MangaKakalotMatchedVia[];
  /** Slugs in the sitemap index. 0 means the index could not be built at all. */
  indexedSlugs: number;
  /** Whether the AniList/MAL-Sync alias bridge was consulted for this query. */
  aliasBridgeRan: boolean;
  /** Alias identities AniList attested for the query (before confirming them against this site). */
  aliasCandidates: number;
  /** Set whenever the answer is empty or degraded. Names the cause in words. */
  warning?: string;
}

export interface IMangaKakalotSearch extends ISearch<IMangaResult> {
  results: IMangaKakalotResult[];
  diagnostics: IMangaKakalotSearchDiagnostics;
}

/** One alias identity that has been confirmed to exist on this site. */
interface AliasHit {
  slug: string;
  via: 'alias-malsync' | 'alias-anilist-title';
}

class MangaKakalot extends MangaParser {
  override readonly name = 'MangaKakalot';
  protected override baseUrl = 'https://www.manganato.gg';
  protected override logo = 'https://www.manganato.gg/images/logo-manganato.webp';
  protected override classPath = 'MANGA.MangaKakalot';

  /**
   * Referer that unlocks the image CDN (`img-r*.2xstorage.com`), for both covers and page images.
   *
   * THE TRAILING SLASH IS LOAD-BEARING. The CDN's hotlink rule matches the origin form exactly.
   * Verified live against a real page image:
   *   no Referer                                       → 403 (4,573 bytes of Cloudflare HTML)
   *   `https://www.manganato.gg`   (no trailing slash) → 403
   *   `https://www.manganato.gg/`                      → 200, 289,722 bytes of image/webp
   *   `https://www.manganato.gg/manga/one-piece/chapter-1190` (the real page) → 403
   * So this cannot be `baseUrl`, and it cannot be the chapter url either.
   */
  private get imageReferer(): string {
    return `${this.baseUrl}/`;
  }

  /**
   * Slug index built from `sitemap.xml`, cached per provider instance. Kept on the instance rather
   * than in module scope so that two providers (or two tests) never share state.
   */
  private searchIndex?: { slugs: string[]; builtAt: number };
  /** De-duplicates concurrent cold searches so they share one index build instead of N. */
  private searchIndexInFlight?: Promise<string[]>;

  /**
   * Set false to switch the AniList/MAL-Sync alias bridge off entirely — no off-site request is
   * then made on any code path, and search is the slug index alone (with its documented blind spot).
   */
  useAliasResolution = true;

  private aliasResolverInstance?: MangaAliasResolver;

  /**
   * The alias bridge, built lazily from THIS PROVIDER'S OWN axios client.
   *
   * Using `this.client` is deliberate and load-bearing: it means one `setAxiosAdapter()` covers the
   * AniList and MAL-Sync calls as well as the manganato ones, so the bridge is exercisable offline
   * by the same fake adapter as the rest of the provider, and any proxy configured on the provider
   * applies to it too.
   */
  private get aliasResolver(): MangaAliasResolver | undefined {
    if (!this.useAliasResolution) return undefined;
    if (!this.aliasResolverInstance)
      this.aliasResolverInstance = new MangaAliasResolver(this.client, new MalSyncIndex(this.client));
    return this.aliasResolverInstance;
  }

  /** Inject a pre-built alias resolver (tests, or a shared instance across providers). */
  setAliasResolver = (resolver: MangaAliasResolver): void => {
    this.aliasResolverInstance = resolver;
  };

  /** Drops the cached slug index and any cached alias lookups. For long-lived processes and tests. */
  clearSearchIndex = (): void => {
    this.searchIndex = undefined;
    this.searchIndexInFlight = undefined;
    this.aliasResolverInstance?.clearCache();
  };

  // ---------------------------------------------------------------------------------------------
  // info
  // ---------------------------------------------------------------------------------------------

  /**
   * @param mangaId the manga slug, e.g. `one-piece`. A full url or a `manga/<slug>` path is also
   *                accepted, so ids copied straight out of a browser keep working.
   */
  override fetchMangaInfo = async (mangaId: string): Promise<IMangaInfo> => {
    const slug = this.normalizeMangaId(mangaId);

    try {
      const { data } = await this.client.get(`${this.baseUrl}/manga/${slug}`);
      const $ = load(data);

      const info: IMangaInfo = {
        id: slug,
        title: $('ul.manga-info-text > li:first-child h1').first().text().trim(),
        headerForImage: { Referer: this.imageReferer },
      };

      // The cover CDN (`img-r*.2xstorage.com`) 403s without the Referer above — hence headerForImage.
      const image = $('div.manga-info-pic img').first().attr('src');
      if (image) info.image = this.absolute(image);

      // The current theme renders no alternative-title element at all. Parsed defensively anyway,
      // because the previous theme did and it may come back.
      const altTitles = $('ul.manga-info-text > li:first-child h2')
        .first()
        .text()
        .replace(/^\s*Alternative\s*:/i, '')
        .split(/[;|]/)
        .map(t => t.trim())
        .filter(Boolean);
      if (altTitles.length) info.altTitles = altTitles;

      const authors = this.infoLine($, 'Author(s)')
        .split(/,|;/)
        .map(a => a.trim())
        .filter(Boolean);
      if (authors.length) info.authors = authors;

      info.genres = $('ul.manga-info-text > li.genres a')
        .map((i, el) => $(el).text().trim())
        .get()
        .filter(Boolean);

      switch (this.infoLine($, 'Status').toLowerCase()) {
        case 'completed':
          info.status = MediaStatus.COMPLETED;
          break;
        case 'ongoing':
          info.status = MediaStatus.ONGOING;
          break;
        default:
          info.status = MediaStatus.UNKNOWN;
      }

      const views = parseInt(this.infoLine($, 'View').replace(/[^0-9]/g, ''), 10);
      if (!Number.isNaN(views)) info.views = views;

      const updatedAt = this.infoLine($, 'Last updated');
      if (updatedAt) info.updatedAt = updatedAt;

      const rating = parseFloat($('div.rating').first().attr('data-default') ?? '');
      if (!Number.isNaN(rating)) info.rating = rating;

      info.description = this.parseDescription($);
      info.chapters = await this.fetchChapters($, slug);

      return info;
    } catch (err) {
      throw new Error(`MangaKakalot: failed to load ${this.baseUrl}/manga/${slug} — ${(err as Error).message}`);
    }
  };

  /**
   * The detail page ships `<div id="chapter-list-container" class="chapter-list-loading">` and
   * fetches the list over JSON, so scraping the page for chapters returns nothing. The API url and
   * the chapter url shape are both declared on that element, so they are read from the page rather
   * than hardcoded — if the site moves the endpoint again, this follows it.
   */
  private fetchChapters = async ($: ReturnType<typeof load>, slug: string): Promise<IMangaChapter[]> => {
    const container = $('#chapter-list-container');
    const pageSlug = container.attr('data-comic-slug')?.trim() || slug;
    const apiUrl = (
      container.attr('data-api-url') || `${this.baseUrl}/api/manga/__SLUG__/chapters`
    ).replace('__SLUG__', encodeURIComponent(pageSlug));

    const chapters: IMangaChapter[] = [];
    try {
      for (let call = 0, offset = 0; call < MAX_CHAPTER_API_CALLS; call++) {
        const { data } = await this.client.get(
          `${apiUrl}?limit=${CHAPTER_API_PAGE_SIZE}&offset=${offset}`
        );
        const payload = typeof data === 'string' ? JSON.parse(data) : data;
        const batch: ChapterApiEntry[] = payload?.data?.chapters ?? [];
        if (!batch.length) break;

        for (const entry of batch) {
          if (!entry?.chapter_slug) continue;
          const chapter: IMangaChapter = {
            id: `${slug}/${entry.chapter_slug}`,
            title: (entry.chapter_name ?? entry.chapter_slug).trim(),
            url: `${this.baseUrl}/manga/${slug}/${entry.chapter_slug}`,
          };
          if (typeof entry.chapter_num === 'number') chapter.chapterNumber = entry.chapter_num;
          if (typeof entry.view === 'number') chapter.views = entry.view;
          if (entry.updated_at) chapter.releasedDate = entry.updated_at;
          chapters.push(chapter);
        }

        offset += batch.length;
        if (!payload?.data?.pagination?.has_more) break;
      }
    } catch {
      // fall through to the server-rendered scrape below
    }

    if (chapters.length) return chapters;

    // Fallback: the pre-lazy-load markup. Kept so that a rollback on their side does not empty
    // every manga's chapter list.
    return $('div.chapter-list > div.row')
      .map((i, el): IMangaChapter | null => {
        const href = $(el).find('span > a').attr('href');
        const chapterSlug = href?.split('/').filter(Boolean).pop();
        if (!chapterSlug) return null;
        return {
          id: `${slug}/${chapterSlug}`,
          title: $(el).find('span > a').text().trim(),
          url: `${this.baseUrl}/manga/${slug}/${chapterSlug}`,
          views: parseInt($(el).find('span:nth-child(2)').text().replace(/,/g, '').trim(), 10),
          releasedDate: $(el).find('span:nth-child(3)').attr('title'),
        };
      })
      .get()
      .filter((c): c is IMangaChapter => c !== null);
  };

  // ---------------------------------------------------------------------------------------------
  // pages
  // ---------------------------------------------------------------------------------------------

  /**
   * @param chapterId `<manga-slug>/<chapter-slug>`, e.g. `one-piece/chapter-1190`.
   */
  override fetchChapterPages = async (chapterId: string): Promise<IMangaChapterPage[]> => {
    const path = this.normalizeChapterId(chapterId);
    const url = `${this.baseUrl}/manga/${path}`;

    try {
      const { data } = await this.client.get(url);
      const $ = load(data);

      return $('div.container-chapter-reader > img')
        .map((i, el): IMangaChapterPage => {
          const img = $(el).attr('src') ?? $(el).attr('data-src') ?? '';
          return {
            img: this.absolute(img),
            page: i,
            title: ($(el).attr('alt') ?? '')
              .replace(/\s*-\s*(MangaNato|MangaKakalot|Manganelo)(\.com|\.gg)?\s*$/i, '')
              .trim(),
            // The page CDN 403s to a request with no Referer — verified live.
            headerForImage: { Referer: this.imageReferer },
          };
        })
        .get()
        .filter(page => page.img);
    } catch (err) {
      throw new Error(`MangaKakalot: failed to load ${url} — ${(err as Error).message}`);
    }
  };

  // ---------------------------------------------------------------------------------------------
  // search
  // ---------------------------------------------------------------------------------------------

  /**
   * Search.
   *
   * WHAT THIS IS. The site's own search API exists but is behind a Cloudflare managed challenge on
   * every path and every client (the full probe log is in the file header — do not re-derive it).
   * So this answers from two corpora instead:
   *
   *   1. **The sitemap slug index** — ~94k slugs across 10 shards, cached for
   *      {@link SEARCH_INDEX_TTL_MS}. This is the site's real catalogue, keyed by slug.
   *   2. **The alias bridge** ({@link MangaAliasResolver}) — AniList synonyms plus MAL-Sync's exact
   *      MangaNato identifier. Consulted ONLY when the query is not already an exact slug, so the
   *      common case still costs zero off-site requests.
   *
   * WHY (2) IS NOT A NICETY. A slug encodes exactly ONE title, and the index alone does not fail
   * quietly — it fails *confidently*. Measured live on 2026-08-14, `demon slayer` returned nine
   * results, all doujinshi or colour re-releases, with the actual series nowhere in them. With the
   * bridge, `demon slayer` resolves through AniList 87216 / MAL 96792 to MAL-Sync's MangaNato
   * identifier `kimetsu-no-yaiba`, which is then confirmed to exist in this site's own sitemap
   * before it is returned. `shingeki no kyojin` → `attack-on-titan` resolves the same way.
   *
   * AN ALIAS IS ATTESTED, THEN CONFIRMED. AniList and MAL-Sync can only assert that a series exists
   * and what it is called; neither knows this site's stock. Every alias slug is therefore checked
   * against the sitemap index (free) or, for at most {@link ALIAS_PROBE_BUDGET} slugs the index does
   * not list, by fetching `/manga/<slug>` and requiring a 200. Nothing unconfirmed is ever returned.
   *
   * WHAT IT STILL CANNOT ANSWER, stated plainly:
   *   - **Series AniList does not carry.** The bridge is only as broad as AniList's manga catalogue.
   *   - **Typos.** Slug matching is substring/token containment with no edit distance; the alias
   *     bridge inherits AniList's tolerance and nothing more.
   *   - **Author, genre or description queries.** Titles only.
   *   - **Exact display titles.** A result flagged `approximateTitle: true` had its title
   *     de-slugified from the url. The top hit on page 1 is enriched from its real detail page.
   *
   * Every return carries {@link IMangaKakalotSearchDiagnostics}; an empty or degraded answer always
   * populates `diagnostics.warning` and logs it.
   *
   * @param query search terms
   * @param page 1-based page of results
   */
  override search = async (query: string, page: number = 1): Promise<IMangaKakalotSearch> => {
    const normalizedQuery = this.slugify(query);
    const currentPage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;

    if (!normalizedQuery)
      return this.emptySearch(currentPage, {
        strategy: [],
        indexedSlugs: 0,
        aliasBridgeRan: false,
        aliasCandidates: 0,
        warning: `MangaKakalot: the query ${JSON.stringify(query)} has no searchable characters.`,
      });

    let index: string[] = [];
    let indexFailed = false;
    try {
      index = await this.getSearchIndex();
    } catch {
      indexFailed = true;
    }
    if (!index.length) indexFailed = true;

    const ranked = index.length ? this.rankSlugs(index, normalizedQuery) : [];
    const exactSlugHit = ranked[0] === normalizedQuery;

    // The bridge is skipped when the query IS a slug on this site — that answer is already exact,
    // and AniList could only agree with it at the cost of two off-site requests.
    let alias: { hits: AliasHit[]; ran: boolean; candidates: number } = { hits: [], ran: false, candidates: 0 };
    if (!exactSlugHit) alias = await this.aliasHits(query, index);

    const via = new Map<string, MangaKakalotMatchedVia>();
    const ordered: string[] = [];
    for (const hit of alias.hits) {
      if (via.has(hit.slug)) continue;
      via.set(hit.slug, hit.via);
      ordered.push(hit.slug);
    }
    for (const slug of ranked) {
      if (via.has(slug)) continue;
      via.set(slug, 'slug-index');
      ordered.push(slug);
    }

    const diagnostics: IMangaKakalotSearchDiagnostics = {
      strategy: [...new Set(ordered.map(slug => via.get(slug)!))],
      indexedSlugs: index.length,
      aliasBridgeRan: alias.ran,
      aliasCandidates: alias.candidates,
    };

    if (!ordered.length) return this.browseFallback(query, normalizedQuery, currentPage, diagnostics, indexFailed);

    // Degraded-but-non-empty answers are the DANGEROUS ones — they look fine. Say so out loud.
    //
    // The condition is "the query was not an exact slug and nothing was confirmed for it", NOT "the
    // bridge ran and failed". Those differ exactly when the bridge is switched off, which is the
    // case that silently returns the confident-but-wrong slug list this provider is guarded against.
    if (indexFailed)
      diagnostics.warning =
        `MangaKakalot: the sitemap slug index was unavailable, so these results come only from the ` +
        `alias bridge. Recall is a small fraction of the catalogue.`;
    else if (!exactSlugHit && !alias.hits.length)
      diagnostics.warning =
        `MangaKakalot: ${JSON.stringify(query)} is not a slug on this site and no alternative title ` +
        `was confirmed for it` +
        (!alias.ran
          ? ` (the alias bridge is DISABLED — useAliasResolution is false — so no synonym was tried).`
          : alias.candidates
            ? ` (the alias bridge ran; AniList attested ${alias.candidates} candidate series, none of ` +
              `which this site stocks under a title we could confirm).`
            : ` (the alias bridge ran; AniList attested no series for this query).`) +
        ` These results are slug-substring matches only, so the series you meant may be absent, or ` +
        `may be listed here under a different romanisation.`;
    if (diagnostics.warning) console.warn(`[mangakakalot] ${diagnostics.warning}`);

    const start = (currentPage - 1) * RESULTS_PER_PAGE;
    const slice = ordered.slice(start, start + RESULTS_PER_PAGE);

    const results: IMangaKakalotResult[] = slice.map(slug => ({
      id: slug,
      title: this.deslugify(slug),
      // The title came from the url, not from the page. Consumers that care can re-fetch.
      approximateTitle: true,
      matchedVia: via.get(slug),
      headerForImage: { Referer: this.imageReferer },
    }));

    // The top hit is what a caller acts on, and one cheap request buys it a real title, cover and
    // description instead of a de-slugified guess. Strictly best-effort. Deliberately NOT
    // `fetchMangaInfo` — that would drag the entire paginated chapter list in on every search.
    if (currentPage === 1 && results.length) {
      const summary = await this.fetchSummary(slice[0]);
      if (summary) results[0] = { ...summary, matchedVia: via.get(slice[0]) };
    }

    return {
      currentPage,
      hasNextPage: start + RESULTS_PER_PAGE < ordered.length,
      totalPages: Math.ceil(ordered.length / RESULTS_PER_PAGE),
      totalResults: ordered.length,
      results,
      diagnostics,
    };
  };

  /**
   * Turn the raw query into slugs on THIS site, via AniList synonyms and MAL-Sync's exact
   * identifier. Never throws: the bridge failing must degrade search, not break it.
   */
  private aliasHits = async (
    query: string,
    index: string[]
  ): Promise<{ hits: AliasHit[]; ran: boolean; candidates: number }> => {
    const resolver = this.aliasResolver;
    if (!resolver) return { hits: [], ran: false, candidates: 0 };

    let candidates;
    try {
      candidates = await resolver.resolve(query);
    } catch (err) {
      // MangaAliasResolver swallows its own faults; this is belt-and-braces so the bridge can never
      // be the reason a search throws.
      console.error(
        `[mangakakalot] the alias bridge threw for ${JSON.stringify(query)} (search continues on the ` +
          `slug index alone): ${(err as Error).message}`
      );
      return { hits: [], ran: true, candidates: 0 };
    }

    const indexed = new Set(index);
    const hits: AliasHit[] = [];
    const seen = new Set<string>();
    let probesLeft = ALIAS_PROBE_BUDGET;

    for (const candidate of candidates.slice(0, ALIAS_MAX_CANDIDATES)) {
      // Proposals, strongest first: MAL-Sync names this site's identifier outright, with no string
      // comparison in the path at all. Slugified AniList titles are the fallback for the series
      // MAL-Sync has no MangaNato entry for.
      const proposals: AliasHit[] = [];
      const push = (slug: string, via: AliasHit['via']) => {
        if (slug && !proposals.some(p => p.slug === slug)) proposals.push({ slug, via });
      };

      const malSyncId = await resolver.providerIdFor(candidate, this.name);
      if (malSyncId) push(this.idPath(malSyncId)[0] ?? '', 'alias-malsync');
      for (const title of candidate.titles.slice(0, ALIAS_MAX_TITLES))
        push(this.slugify(title), 'alias-anilist-title');

      let chosen = proposals.find(p => indexed.has(p.slug));
      // Nothing in the index. The sitemap can be stale or (when it failed to build) empty, so spend
      // a bounded number of direct confirmations rather than dropping an attested identity.
      if (!chosen && probesLeft > 0 && proposals.length) {
        probesLeft--;
        if (await this.slugExists(proposals[0].slug)) chosen = proposals[0];
      }

      if (!chosen || seen.has(chosen.slug)) continue;
      seen.add(chosen.slug);
      hits.push(chosen);
    }

    return { hits, ran: true, candidates: candidates.length };
  };

  /** Does `/manga/<slug>` exist? A missing slug answers 404 on this host — verified live. */
  private slugExists = async (slug: string): Promise<boolean> => {
    if (!slug) return false;
    try {
      const res = await this.client.get(`${this.baseUrl}/manga/${slug}`, { validateStatus: () => true });
      return res.status === 200;
    } catch {
      return false;
    }
  };

  /**
   * The detail page reduced to what a search result needs — title, cover, description — WITHOUT the
   * paginated chapter API that `fetchMangaInfo` walks. Returns null for anything but a real page.
   */
  private fetchSummary = async (slug: string): Promise<IMangaKakalotResult | null> => {
    try {
      const res = await this.client.get(`${this.baseUrl}/manga/${slug}`, { validateStatus: () => true });
      if (res.status !== 200) return null;
      const $ = load(res.data);
      const title = $('ul.manga-info-text > li:first-child h1').first().text().trim();
      if (!title) return null;

      const result: IMangaKakalotResult = { id: slug, title, headerForImage: { Referer: this.imageReferer } };
      const image = $('div.manga-info-pic img').first().attr('src');
      if (image) result.image = this.absolute(image);
      const description = this.parseDescription($);
      if (description) result.description = description;
      return result;
    } catch {
      return null;
    }
  };

  private emptySearch = (
    currentPage: number,
    diagnostics: IMangaKakalotSearchDiagnostics
  ): IMangaKakalotSearch => {
    if (diagnostics.warning) console.warn(`[mangakakalot] ${diagnostics.warning}`);
    return { currentPage, hasNextPage: false, totalPages: 0, totalResults: 0, results: [], diagnostics };
  };

  /** Returns the cached slug index, building it if missing or stale. */
  private getSearchIndex = async (): Promise<string[]> => {
    if (this.searchIndex && Date.now() - this.searchIndex.builtAt < SEARCH_INDEX_TTL_MS)
      return this.searchIndex.slugs;
    if (this.searchIndexInFlight) return this.searchIndexInFlight;

    this.searchIndexInFlight = this.buildSearchIndex()
      .then(slugs => {
        if (slugs.length) this.searchIndex = { slugs, builtAt: Date.now() };
        return slugs;
      })
      .finally(() => {
        this.searchIndexInFlight = undefined;
      });

    return this.searchIndexInFlight;
  };

  /**
   * Builds the slug index from `sitemap.xml` → `sitemap-comic-N.xml`. The shards are ordered by
   * last-modified descending, and that order is preserved so that ties in the ranking fall out as
   * "most recently updated first".
   */
  private buildSearchIndex = async (): Promise<string[]> => {
    const { data } = await this.client.get(`${this.baseUrl}/sitemap.xml`);
    const shardUrls = this.extractLocs(String(data))
      .filter(loc => /sitemap[^/]*\.xml$/i.test(loc) && !/sitemap\.xml$/i.test(loc))
      .slice(0, MAX_SITEMAP_SHARDS);

    if (!shardUrls.length) return [];

    const shards = await Promise.all(
      shardUrls.map(async url => {
        try {
          const res = await this.client.get(url);
          return this.extractSlugs(String(res.data));
        } catch {
          return [] as string[];
        }
      })
    );

    const seen = new Set<string>();
    const slugs: string[] = [];
    for (const shard of shards)
      for (const slug of shard) {
        if (seen.has(slug)) continue;
        seen.add(slug);
        slugs.push(slug);
        if (slugs.length >= MAX_INDEXED_SLUGS) return slugs;
      }
    return slugs;
  };

  private extractLocs = (xml: string): string[] =>
    Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi), m => m[1]);

  private extractSlugs = (xml: string): string[] =>
    Array.from(xml.matchAll(/\/manga\/([^<>\s/]+)\s*<\/loc>/gi), m => m[1].toLowerCase());

  /**
   * Orders slugs by how well they match the slugified query. Lower is better; ties keep the
   * index's own (recency) order.
   */
  private rankSlugs = (slugs: string[], query: string): string[] => {
    const tokens = query.split('-').filter(Boolean);

    const score = (slug: string): number => {
      if (slug === query) return 0;
      if (slug.startsWith(`${query}-`)) return 1;
      if (slug.endsWith(`-${query}`)) return 2;
      if (slug.includes(`-${query}-`)) return 3;
      if (slug.includes(query)) return 4;
      if (tokens.length > 1) {
        const parts = slug.split('-');
        if (tokens.every(t => parts.includes(t))) return 5;
        if (tokens.every(t => slug.includes(t))) return 6;
      }
      return Number.POSITIVE_INFINITY;
    };

    return slugs
      .map((slug, order) => ({ slug, order, score: score(slug) }))
      .filter(entry => entry.score !== Number.POSITIVE_INFINITY)
      .sort((a, b) => a.score - b.score || a.order - b.order)
      .map(entry => entry.slug);
  };

  /**
   * Last resort when neither the sitemap index nor the alias bridge produced a slug: probe the
   * query as a literal slug, then scan the front page of the browse listings. Recall is tiny —
   * roughly the ~60 most recently updated/most popular titles plus any exact-slug hit — but it
   * keeps search returning something useful instead of throwing. Only page 1 of each listing is
   * fetched; `robots.txt` disallows `*?page=*`, so this does not paginate them.
   */
  private browseFallback = async (
    rawQuery: string,
    query: string,
    currentPage: number,
    diagnostics: IMangaKakalotSearchDiagnostics,
    indexFailed: boolean
  ): Promise<IMangaKakalotSearch> => {
    const results: IMangaKakalotResult[] = [];
    const seen = new Set<string>();

    const direct = await this.fetchSummary(query);
    if (direct) {
      seen.add(query);
      results.push({ ...direct, matchedVia: 'slug-probe' });
    }

    const tokens = query.split('-').filter(Boolean);
    for (const listing of BROWSE_LISTINGS) {
      try {
        const { data } = await this.client.get(`${this.baseUrl}${listing}`);
        const $ = load(data);
        $('div.list-comic-item-wrap').each((i, el) => {
          const link = $(el).find('h3 > a').first();
          const href = link.attr('href') ?? '';
          const slug = href.split('/manga/')[1]?.split(/[?#/]/)[0];
          // The listing carries a hidden advertising card whose links are `#`.
          if (!slug || seen.has(slug)) return;
          const title = (link.attr('title') || link.text()).trim();
          const haystack = `${slug} ${this.slugify(title)}`;
          if (!tokens.every(t => haystack.includes(t))) return;
          seen.add(slug);
          const img = $(el).find('a img').first();
          results.push({
            id: slug,
            title,
            image: this.absolute(img.attr('data-src') || img.attr('src') || ''),
            matchedVia: 'browse-listing',
            headerForImage: { Referer: this.imageReferer },
          });
        });
      } catch {
        // a dead listing must not sink the others
      }
    }

    diagnostics.strategy = [...new Set(results.map(r => r.matchedVia!))];
    // Both branches below are the silent-failure shapes this provider is guarded against. Neither
    // may be reported as a plain empty array.
    diagnostics.warning = results.length
      ? `MangaKakalot: neither the sitemap slug index nor the alias bridge produced a hit for ` +
        `${JSON.stringify(rawQuery)}; these results are scraped from the front page of the browse ` +
        `listings, which is roughly the 60 most recent/popular titles, not the catalogue.`
      : `MangaKakalot: NO results for ${JSON.stringify(rawQuery)}. ` +
        (indexFailed
          ? `The sitemap slug index could not be built (0 slugs), so the catalogue was never searched — ` +
            `this is an upstream failure, not evidence the series is absent. `
          : `The sitemap slug index (${diagnostics.indexedSlugs} slugs) held no match. `) +
        (diagnostics.aliasBridgeRan
          ? `The alias bridge ran and AniList attested ${diagnostics.aliasCandidates} candidate series, ` +
            `none confirmable on this site.`
          : `The alias bridge did NOT run (useAliasResolution is off), so no alternative title was tried.`);
    console.warn(`[mangakakalot] ${diagnostics.warning}`);

    const start = (currentPage - 1) * RESULTS_PER_PAGE;
    return {
      currentPage,
      hasNextPage: start + RESULTS_PER_PAGE < results.length,
      totalPages: Math.ceil(results.length / RESULTS_PER_PAGE) || 0,
      totalResults: results.length,
      results: results.slice(start, start + RESULTS_PER_PAGE),
      diagnostics,
    };
  };

  // ---------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------

  /** Accepts a bare slug, a `manga/<slug>` path, or a full detail url. */
  private normalizeMangaId = (mangaId: string): string => {
    const slug = this.idPath(mangaId)[0];
    if (!slug) throw new Error(`MangaKakalot: "${mangaId}" is not a usable manga id (expected a slug like "one-piece")`);
    return slug;
  };

  /**
   * Accepts `<slug>/<chapter-slug>`, a `manga/...` path, or a full chapter url. Ids in the old
   * `<chapter-id>` / `<path>$$READMANGANATO` shapes cannot be mapped onto the new host, so they
   * fail loudly rather than silently fetching the wrong thing.
   */
  private normalizeChapterId = (chapterId: string): string => {
    const parts = this.idPath(chapterId);
    if (parts.length < 2)
      throw new Error(
        `MangaKakalot: "${chapterId}" is not a usable chapter id. Since the move to ${this.baseUrl} a ` +
          `chapter id is "<manga-slug>/<chapter-slug>", e.g. "one-piece/chapter-1190". Re-fetch the ` +
          `manga info to get current ids.`
      );
    return `${parts[0]}/${parts[1]}`;
  };

  /**
   * Reduces any accepted id form — bare slug, `manga/<slug>/<chapter>` path, full url, or a legacy
   * `$$READMANGANATO`-suffixed id — to its path segments below `/manga/`.
   */
  private idPath = (value: string): string[] =>
    value
      .trim()
      .replace(/\$\$READMANGANATO$/i, '')
      .replace(/[?#].*$/, '')
      .replace(/^https?:\/\/[^/]+/i, '')
      .replace(/^\/+/, '')
      .replace(/^manga\//i, '')
      .split('/')
      .filter(Boolean);

  /**
   * Reads a `<li>Label : value</li>` row out of the info table. Compares the text before the first
   * colon literally — building a RegExp from the label instead silently mis-parsed `Author(s)`,
   * whose parentheses are a capture group, so every manga came back with no authors.
   */
  private infoLine = ($: ReturnType<typeof load>, label: string): string => {
    const wanted = label.toLowerCase();
    let value = '';
    $('ul.manga-info-text > li').each((i, el) => {
      if (value) return;
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      const colon = text.indexOf(':');
      if (colon < 0) return;
      if (text.slice(0, colon).trim().toLowerCase() === wanted) value = text.slice(colon + 1).trim();
    });
    return value;
  };

  /**
   * The synopsis lives in `#contentBox` behind an `<h2><p>… summary:</p></h2>` heading, and its
   * markup is double-escaped — cheerio's `.text()` decodes one layer and leaves literal `<br>` and
   * `<b>` strings behind, which is why they are stripped as text here rather than as elements.
   */
  private parseDescription = ($: ReturnType<typeof load>): string => {
    const box = $('#contentBox').first().clone();
    if (!box.length) return '';
    box.find('h2').remove();

    return this.decodeEntities(box.text())
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/^\s*.*?\bsummary\s*:/i, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };

  private decodeEntities = (value: string): string =>
    value
      .replace(/&nbsp;/gi, ' ')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');

  private absolute = (url: string): string => {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('//')) return `https:${url}`;
    return `${this.baseUrl}/${url.replace(/^\/+/, '')}`;
  };

  private slugify = (value: string): string =>
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  private deslugify = (slug: string): string =>
    slug
      .split('-')
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
}

export default MangaKakalot;
