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
 * SEARCH IS DELIBERATELY BLOCKED. `/search/story/<q>` returns 403 to every non-browser client, and
 * `robots.txt` says so out loud — it disallows every `/search/story/` path. There is no header that fixes it and
 * we do not try. Instead `search()` runs against a slug index built from the site's own
 * `sitemap.xml`, which `robots.txt` explicitly advertises. See `search()` for what that can and
 * cannot answer — it is a slug index, not the site's search engine.
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

/** Browse listings used as a last-resort search corpus when the sitemap index is unavailable. */
const BROWSE_LISTINGS = ['/manga-list/latest-manga', '/manga-list/hot-manga', '/manga-list/new-manga'];

interface ChapterApiEntry {
  chapter_name?: string;
  chapter_slug?: string;
  chapter_num?: number;
  updated_at?: string;
  view?: number;
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

  /** Drops the cached slug index. Mostly useful for long-lived processes and for tests. */
  clearSearchIndex = (): void => {
    this.searchIndex = undefined;
    this.searchIndexInFlight = undefined;
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
   * WHAT THIS IS. The site's own search (`/search/story/<q>`) is 403 to every non-browser client and
   * `robots.txt` disallows it outright, so this does not use it. It instead matches the query
   * against a slug index built from `sitemap.xml` (~94k manga across 10 shards, ~2.4MB gzipped,
   * cached for {@link SEARCH_INDEX_TTL_MS}).
   *
   * WHAT IT ANSWERS WELL. Anything whose title matches the slug the site chose: `one piece`,
   * `solo leveling`, `chainsaw man`, `jujutsu kaisen` all resolve exactly, and partial words like
   * `kaguya` return every slug containing them, most-recently-updated first.
   *
   * WHAT IT CANNOT ANSWER — this is not the site's search engine and should not be sold as one:
   *   - **Alternative titles.** A slug encodes ONE title. `kimetsu no yaiba` hits; `demon slayer`
   *     does not. `attack on titan` hits; `shingeki no kyojin` does not. Which variant the site
   *     slugged is not predictable.
   *   - **Typos and fuzziness.** Matching is substring/token containment. There is no edit distance.
   *   - **Anything not in the title.** No author, genre or description search.
   *   - **Exact display titles.** Results carry a title de-slugified from the url, so punctuation and
   *     capitalisation are approximations and are flagged with `approximateTitle: true`. The only
   *     exception is an exact-slug top hit on page 1, which is enriched from its real detail page.
   *
   * @param query search terms
   * @param page 1-based page of results
   */
  override search = async (query: string, page: number = 1): Promise<ISearch<IMangaResult>> => {
    const normalizedQuery = this.slugify(query);
    const currentPage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;

    if (!normalizedQuery) return { currentPage, hasNextPage: false, totalPages: 0, totalResults: 0, results: [] };

    let ranked: string[] = [];
    try {
      ranked = this.rankSlugs(await this.getSearchIndex(), normalizedQuery);
    } catch {
      // index unavailable — handled by the browse fallback below
    }

    if (!ranked.length) return this.browseFallback(normalizedQuery, currentPage);

    const start = (currentPage - 1) * RESULTS_PER_PAGE;
    const slice = ranked.slice(start, start + RESULTS_PER_PAGE);

    const results: IMangaResult[] = slice.map(slug => ({
      id: slug,
      title: this.deslugify(slug),
      // The title came from the url, not from the page. Consumers that care can re-fetch.
      approximateTitle: true,
      headerForImage: { Referer: this.imageReferer },
    }));

    // An exact slug hit is the overwhelmingly common query shape, and one extra request buys it a
    // real title, cover and description instead of a de-slugified guess. Strictly best-effort.
    if (currentPage === 1 && results.length && slice[0] === normalizedQuery) {
      try {
        const info = await this.fetchMangaInfo(slice[0]);
        results[0] = {
          id: info.id,
          title: info.title,
          image: info.image,
          description: info.description,
          status: info.status,
          headerForImage: { Referer: this.imageReferer },
        };
      } catch {
        // keep the de-slugified result
      }
    }

    return {
      currentPage,
      hasNextPage: start + RESULTS_PER_PAGE < ranked.length,
      totalPages: Math.ceil(ranked.length / RESULTS_PER_PAGE),
      totalResults: ranked.length,
      results,
    };
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
   * Last resort when the sitemap is unreachable or empty: probe the query as a literal slug, then
   * scan the front page of the browse listings. Recall is tiny — roughly the ~60 most recently
   * updated/most popular titles plus any exact-slug hit — but it keeps search returning something
   * useful instead of throwing. Only page 1 of each listing is fetched; `robots.txt` disallows
   * `*?page=*`, so this does not paginate them.
   */
  private browseFallback = async (query: string, currentPage: number): Promise<ISearch<IMangaResult>> => {
    const results: IMangaResult[] = [];
    const seen = new Set<string>();

    try {
      const res = await this.client.get(`${this.baseUrl}/manga/${query}`, {
        validateStatus: () => true,
      });
      if (res.status === 200) {
        const $ = load(res.data);
        const title = $('ul.manga-info-text > li:first-child h1').first().text().trim();
        if (title) {
          seen.add(query);
          results.push({
            id: query,
            title,
            image: this.absolute($('div.manga-info-pic img').first().attr('src') ?? ''),
            headerForImage: { Referer: this.imageReferer },
          });
        }
      }
    } catch {
      // ignore — the listing scan below may still find something
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
            headerForImage: { Referer: this.imageReferer },
          });
        });
      } catch {
        // a dead listing must not sink the others
      }
    }

    const start = (currentPage - 1) * RESULTS_PER_PAGE;
    return {
      currentPage,
      hasNextPage: start + RESULTS_PER_PAGE < results.length,
      totalPages: Math.ceil(results.length / RESULTS_PER_PAGE) || 0,
      totalResults: results.length,
      results: results.slice(start, start + RESULTS_PER_PAGE),
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
