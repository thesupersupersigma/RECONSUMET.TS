import { AxiosError } from 'axios';
import { load } from 'cheerio';

import {
  IMangaChapter,
  IMangaChapterPage,
  IMangaInfo,
  IMangaResult,
  ISearch,
  MangaParser,
  MediaStatus,
} from '../../models';
import { EmbeddedJsonError, extractEmbeddedJson } from '../../utils/embedded-json';
import { USER_AGENT } from '../../utils/utils';

/**
 * AsuraScans — rebuilt site, public JSON API, no scraping.
 *
 * WHY THIS IS A REWRITE AND NOT A SELECTOR REFRESH
 * ------------------------------------------------
 * The provider was pointed at `asuracomic.net`. That host still answers, but it 301s to
 * `https://asurascans.com/` **discarding the path and the query** — reproduced live:
 *
 *     curl -sIL https://asuracomic.net/series/solo-leveling  ->  200  https://asurascans.com/
 *
 * so every request this provider made — info, chapter, search — silently fetched the homepage and
 * ran cheerio selectors over it. `fetchMangaInfo('literally-anything')` therefore RESOLVED, with
 * `{ title: 'Popular', chapters: [], image: undefined }`, instead of throwing. Textbook fail-open:
 * no error anywhere, a well-formed object, and every field wrong. Nothing about the old selectors
 * was salvageable because none of them had been run against a real page in a long time.
 *
 * The site is now three Cloudflare-fronted hosts, all plain HTTP, none needing auth or a cookie:
 *   asurascans.com      Astro SSR HTML  (canonical URLs: `/comics/<slug>-7e1f454a[/chapter/<n>]`)
 *   api.asurascans.com  the JSON API this provider speaks
 *   cdn.asurascans.com  the images
 *
 * `/series/...` — the route the old code used — is a hard 404 now. `/comics/...` replaced it.
 *
 * ENDPOINTS (all verified live 2026-08-14 from residential egress)
 *   GET /api/series?search=<q>&offset=<n>&limit=<n>   -> { data: Series[] | null, meta: Meta }
 *   GET /api/series/<slug>                            -> { series: Series, recommended_series: [] }
 *   GET /api/series/<slug>/chapters                   -> { data: ChapterStub[] }   (ALL of them)
 *   GET /api/series/<slug>/chapters/<number>          -> { data: { chapter, is_locked, ... } }
 * `api.asurascans.com/` itself is a 404 — only `/api/*` exists. There is no `/api/latest`,
 * `/api/popular` or `/api/home`; `/api/genres` exists and is a flat tag list.
 *
 * FOUR API BEHAVIOURS THAT SILENTLY RETURN THE WRONG ANSWER
 * ---------------------------------------------------------
 * Each of these answers HTTP 200 with a well-formed body, which is the only reason they need
 * writing down. Every one is measured, not inferred.
 *
 *  1. `page` IS NOT A PARAMETER. `?page=2`, `?page=3`, `?page=99` all return page ONE, with
 *     `meta.has_more: true` forever. The real cursor is `offset`. The triage note for this rewrite
 *     said `?search=<q>&page=<n>`; it is wrong, and a provider built on it paginates in place.
 *  2. `limit` CAPS AT 50, AND OVERFLOW FALLS BACK TO THE DEFAULT rather than clamping: `limit=50`
 *     yields 50, `limit=51` yields **20**, and so does `limit=100`, `limit=0`, `limit=-1`. Asking
 *     for more quietly gets you fewer. {@link AsuraScans.search} refuses out-of-range limits.
 *  3. `order` IS A COIN FLIP. Any non-empty value — `update`, `popular`, `rating`, `bogus` —
 *     produces the same, single alternative ordering; the value itself is ignored. There is no
 *     `fetchPopular`/`fetchLatestUpdates` here because the API cannot honestly back one.
 *  4. PAST THE END, `data` IS `null`, NOT `[]`, and `meta.has_more` is omitted entirely rather than
 *     sent as `false`. Both are handled below; `null.map` is how this would otherwise surface.
 *
 * IDS
 *   manga id   the bare slug, `solo-leveling`. The site's canonical URL carries a `-7e1f454a`
 *              suffix, but that suffix is a SITE-WIDE CONSTANT (identical on all 339 series), the
 *              API accepts the slug with or without it, and `/comics/<bare-slug>` 301s to the
 *              suffixed form. So the bare slug is the stable id and nothing has to be memoised.
 *   chapter id `<series-slug>/chapter/<number>` — the site's own path shape, self-contained so a
 *              caller can hand it straight back to {@link fetchChapterPages}. Tolerant on input:
 *              a full URL, a `/comics/...` path, or `<slug>/<number>` all parse.
 *              NOTE the chapter's own `slug` field is NOT usable as an addressing key: it is a
 *              UUID on older series (`8cefbb44-d121-…`) and `chapter-139` on newer ones. `number`
 *              is the key, and it can be fractional (`0.5`, addressed as `/chapters/0.5`).
 *
 * IMAGES. `cdn.asurascans.com` serves chapter pages and covers with NO Referer and no cookie —
 * measured: 248,750 bytes of `image/webp`, magic `52 49 46 46 … 57 45 42 50`, with a bare curl.
 * The `?v=<unix-ts>` on page URLs is a cache-buster only; stripping it returns byte-identical
 * content, so it is passed through untouched (the response is `immutable, max-age=31536000`).
 *
 * USER-AGENT. All three hosts share a UA blocklist — `Python-urllib/3.14` gets **403** from
 * api., cdn. AND the HTML host, while an absent UA, `Consumet/1.0`, `axios/1.6.0` and a Chrome UA
 * all get 200. So this is not the ComicK-style "browser UA from a non-browser TLS stack" trap;
 * it is a plain deny-list of obvious library UAs. The shared {@link USER_AGENT} is sent explicitly
 * on every request and handed to the caller for the image fetches, exactly as MangaDex does.
 */
class AsuraScans extends MangaParser {
  override readonly name = 'AsuraScans';
  protected override baseUrl = 'https://asurascans.com';
  protected override logo = 'https://cdn.asurascans.com/asura-images/logo.webp';
  protected override classPath = 'MANGA.AsuraScans';

  private readonly apiUrl = 'https://api.asurascans.com/api';

  /** The API's hard ceiling. 51+ does not clamp to 50 — it reverts to the default 20. */
  private static readonly MAX_LIMIT = 50;

  private get headers(): { [key: string]: string } {
    return { 'User-Agent': USER_AGENT, Referer: `${this.baseUrl}/` };
  }

  // --------------------------------------------------------------------------------- search

  /**
   * @param query search query; empty walks the whole catalogue (339 series at time of writing)
   * @param page 1-based, translated to `offset` because the API ignores `page` (see class note)
   * @param limit results per page, 1..50 — the API's real ceiling
   */
  override search = async (query: string, page: number = 1, limit: number = 20): Promise<ISearch<IMangaResult>> => {
    if (!Number.isInteger(page) || page <= 0) throw new Error(`[${this.name}] page must be a positive integer`);
    if (!Number.isInteger(limit) || limit <= 0 || limit > AsuraScans.MAX_LIMIT)
      throw new Error(
        `[${this.name}] limit must be an integer in 1..${AsuraScans.MAX_LIMIT} — the API does not clamp ` +
          `an over-large limit, it silently falls back to 20`
      );

    const offset = (page - 1) * limit;
    const url = `${this.apiUrl}/series?search=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`;
    const body = await this.getJson(url);

    // `data: null` past the last page is the API's real answer, not an error.
    const rows = asArray(asRecord(body)?.data);
    const meta = asRecord(asRecord(body)?.meta);
    const total = asNumber(meta?.total);

    return {
      currentPage: page,
      // `has_more` is omitted (not `false`) on the last page, so the arithmetic is the backstop.
      hasNextPage: meta?.has_more === true || (total !== undefined && offset + rows.length < total),
      totalResults: total,
      totalPages: total === undefined ? undefined : Math.max(1, Math.ceil(total / limit)),
      results: rows.map(row => this.toResult(row)).filter((r): r is IMangaResult => r !== null),
    };
  };

  // ------------------------------------------------------------------------------ manga info

  /**
   * @param mangaId a slug (`solo-leveling`), a `/comics/<slug>-7e1f454a` path, or a full site URL.
   *
   * Throws on an unknown series — the API 404s `{"error":"series not found"}` and that rejection is
   * allowed to propagate as a named error. The whole point of the rewrite: this used to resolve.
   */
  override fetchMangaInfo = async (mangaId: string): Promise<IMangaInfo> => {
    const slug = this.parseSeriesId(mangaId);

    const [detail, chapterBody] = await Promise.all([
      this.getJson(`${this.apiUrl}/series/${encodeURIComponent(slug)}`),
      this.getJson(`${this.apiUrl}/series/${encodeURIComponent(slug)}/chapters`),
    ]);

    // The detail endpoint answers `{series, recommended_series}` at the TOP level — it is not
    // wrapped in `data` the way the list endpoints are. Accept both so a future rewrap is a no-op.
    const root = asRecord(asRecord(detail)?.data) ?? asRecord(detail);
    const series = asRecord(root?.series);
    if (!series) throw new Error(`[${this.name}] no series object in the API response for "${slug}" (${this.apiUrl}/series/${slug})`);

    // Prefer the slug the API itself echoes: it is the canonical, un-suffixed one even when the
    // caller passed the `-7e1f454a` form, so every id this method emits is stable.
    const canonical = asString(series.slug) ?? slug;
    const description = asString(series.description);

    return {
      id: canonical,
      title: asString(series.title) ?? canonical,
      altTitles: asArray(series.alt_titles).filter((t): t is string => typeof t === 'string'),
      image: asString(series.cover),
      cover: asString(series.banner),
      description: description === undefined ? undefined : htmlToText(description),
      status: AsuraScans.toMediaStatus(asString(series.status)),
      // one string, not an array: the API has a single `author` field, and splitting it on a
      // separator it does not use is how the old code produced `['']`.
      authors: asString(series.author) === undefined ? [] : [asString(series.author)!],
      artist: asString(series.artist),
      type: asString(series.type),
      rating: asNumber(series.rating),
      bookmarkCount: asNumber(series.bookmark_count),
      popularityRank: asNumber(series.popularity_rank),
      chapterCount: asNumber(series.chapter_count),
      updatedOn: asString(series.last_chapter_at),
      genres: asArray(series.genres)
        .map(g => asString(asRecord(g)?.name))
        .filter((g): g is string => g !== undefined),
      url: `${this.baseUrl}${asString(series.public_url) ?? `/comics/${canonical}`}`,
      // the CDN needs no Referer, but all three hosts deny-list library UAs — tell the caller.
      headers: this.headers,
      chapters: asArray(asRecord(chapterBody)?.data)
        .map(c => this.toChapter(c, canonical))
        .filter((c): c is IMangaChapter => c !== null),
      recommendations: asArray(root?.recommended_series)
        .map(r => this.toResult(r))
        .filter((r): r is IMangaResult => r !== null),
    };
  };

  // --------------------------------------------------------------------------- chapter pages

  /**
   * @param chapterId `<series-slug>/chapter/<number>` (what {@link fetchMangaInfo} emits), or any
   *                  of the tolerated forms listed in the class note.
   *
   * PRIMARY PATH is the JSON API. THE HTML FALLBACK IS DELIBERATE, AND IT IS THE ONLY ONE:
   * `api.asurascans.com` is a bare, unauthenticated subdomain, i.e. precisely the thing an operator
   * firewalls first, and if it goes the provider is worthless — search and info degrade to "no
   * results", but no pages means no reader at all. The same page list is server-rendered into the
   * chapter page's single `<astro-island>` (`ChapterReader`), which cannot be turned off without
   * breaking the site itself, so the fallback costs one extra request only on a path that has
   * already failed. It is exercised by the committed test with a real captured island, not left as
   * untested scaffolding. Deliberately NOT built for search/info: there the HTML carries no data
   * the API does not, so a second path there would be pure liability.
   *
   * LOCKED CHAPTERS ARE THE FAIL-OPEN CASE HERE, and both paths check for them. An early-access
   * chapter answers **HTTP 200** with `is_locked: true` and `chapter.pages: null`, `page_count: 0`
   * — captured live from `got-dropped-into-a-ghost-story-still-gotta-work` ch.30. Mapping `pages`
   * naively yields `[]` and a blank reader, which is the exact MangaDex defect wave 1 fixed. So
   * this throws, per the house convention, and {@link fetchMangaInfo} pre-flags those chapters
   * `readable: false` so a caller never has to reach the throw.
   */
  override fetchChapterPages = async (chapterId: string): Promise<IMangaChapterPage[]> => {
    const { slug, number } = this.parseChapterId(chapterId);
    const apiUrl = `${this.apiUrl}/series/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(number)}`;

    let apiFailure: Error;
    try {
      const wrapper = asRecord(asRecord(await this.getJson(apiUrl))?.data);
      const chapter = asRecord(wrapper?.chapter);
      this.assertUnlocked(chapterId, slug, number, {
        locked: wrapper?.is_locked === true || chapter?.is_locked === true,
        premium: chapter?.is_premium === true,
        unlockTime: asString(wrapper?.unlock_time) ?? asString(chapter?.unlock_time),
      });

      const pages = this.toPages(chapter?.pages);
      if (pages.length > 0) return pages;
      apiFailure = new Error(`the API returned HTTP 200 with no pages for an unlocked chapter (${apiUrl})`);
    } catch (err) {
      if (err instanceof ChapterLockedError) throw err; // a locked chapter is an answer, not a fault
      apiFailure = err instanceof Error ? err : new Error(String(err));
    }

    try {
      return await this.chapterPagesFromHtml(chapterId, slug, number);
    } catch (err) {
      if (err instanceof ChapterLockedError) throw err;
      throw new Error(
        `[${this.name}] could not read chapter "${chapterId}". ` +
          `JSON API: ${apiFailure.message}. HTML fallback: ${(err as Error).message}`
      );
    }
  };

  /** The `<astro-island>` fallback. Same page list, server-rendered, same lock check. */
  private chapterPagesFromHtml = async (
    chapterId: string,
    slug: string,
    number: string
  ): Promise<IMangaChapterPage[]> => {
    const url = `${this.baseUrl}/comics/${encodeURIComponent(slug)}/chapter/${encodeURIComponent(number)}`;
    const { data } = await this.client.get(url, { headers: this.headers, responseType: 'text' });
    if (typeof data !== 'string') throw new Error(`expected HTML from ${url}, got ${typeof data}`);

    let props: unknown;
    try {
      // Exactly one island on a chapter page, so the locator is a guard against the site adding
      // more rather than a disambiguator. `astro-props` results arrive already tuple-decoded.
      props = extractEmbeddedJson(data, { shapes: ['astro-props'], locator: /ChapterReader/, source: url });
    } catch (err) {
      if (err instanceof EmbeddedJsonError) throw new Error(`${err.message} [${err.reason}]`);
      throw err;
    }

    const island = asRecord(props);
    this.assertUnlocked(chapterId, slug, number, {
      locked: island?.isLocked === true,
      premium: island?.isPremium === true,
      unlockTime: asString(island?.unlockTime),
    });

    const pages = this.toPages(island?.pages);
    if (pages.length === 0) throw new Error(`the ChapterReader island on ${url} carried no usable page urls`);
    return pages;
  };

  /** `{url,width,height}[]` -> `IMangaChapterPage[]`, page numbers re-derived from array order. */
  private toPages = (raw: unknown): IMangaChapterPage[] =>
    asArray(raw)
      .map(entry => asString(asRecord(entry)?.url))
      .filter((url): url is string => url !== undefined)
      .map((img, index) => ({
        img,
        page: index + 1,
        // no hotlink protection on the CDN (verified with no Referer at all), but every
        // asurascans host 403s a deny-listed library UA, so the caller is told what to send.
        headers: this.headers,
      }));

  /**
   * Throw {@link ChapterLockedError} if this chapter is behind early access.
   *
   * WHY AN ERROR AND NOT AN EMPTY ARRAY — the same reasoning as MangaDex's `unreadableChapterError`
   * (src/providers/manga/mangadex.ts): every provider in this tree signals "not available from me"
   * by throwing, because an aggregator's per-provider fallthrough keys on the throw. Returning `[]`
   * makes AsuraScans look like a successful source with a genuinely zero-page chapter.
   */
  private assertUnlocked = (
    chapterId: string,
    slug: string,
    number: string,
    flags: { locked: boolean; premium: boolean; unlockTime?: string }
  ): void => {
    if (!flags.locked) return;
    throw new ChapterLockedError(
      `[${this.name}] chapter "${chapterId}" is locked behind early access and has no readable pages ` +
        `(is_locked: true${flags.premium ? ', is_premium: true' : ''}` +
        `${flags.unlockTime ? `, unlocks ${flags.unlockTime}` : ''}). ` +
        `The API answers HTTP 200 with \`pages: null\` for these, so it cannot be told apart from a real ` +
        `chapter without the flag. It becomes free to read at ` +
        `${this.baseUrl}/comics/${slug}/chapter/${number}. ` +
        'fetchMangaInfo marks these chapters `readable: false` and carries their `externalUrl`.'
    );
  };

  // ----------------------------------------------------------------------------- id handling

  /** `solo-leveling` | `/comics/solo-leveling-7e1f454a` | a full site URL -> the slug segment. */
  private parseSeriesId = (mangaId: string): string => {
    const segments = pathSegments(mangaId);
    if (segments[0] === 'comics' || segments[0] === 'series') segments.shift();
    const slug = segments[0];
    if (slug === undefined)
      throw new Error(`[${this.name}] "${mangaId}" is not a usable series id — expected a slug like "solo-leveling"`);
    return slug;
  };

  /**
   * `<slug>/chapter/<n>` | `<slug>/<n>` | `/comics/<slug>-7e1f454a/chapter/<n>` | a full URL.
   *
   * `<n>` stays a STRING all the way to the URL: chapter numbers are fractional in the wild
   * (`0.5`), and `parseInt`-ing them here is how "chapter 0.5" becomes "chapter 0".
   */
  private parseChapterId = (chapterId: string): { slug: string; number: string } => {
    const segments = pathSegments(chapterId);
    if (segments[0] === 'comics' || segments[0] === 'series') segments.shift();
    const slug = segments.shift();
    if (segments[0] === 'chapter' || segments[0] === 'chapters') segments.shift();
    const number = segments.shift();
    if (slug === undefined || number === undefined || segments.length > 0)
      throw new Error(
        `[${this.name}] "${chapterId}" is not a usable chapter id — expected "<series-slug>/chapter/<number>", ` +
          'as emitted by fetchMangaInfo'
      );
    return { slug, number };
  };

  // ------------------------------------------------------------------------------- mapping

  /** A `Series` row from either the list endpoint or `recommended_series` (which uses `cover_url`). */
  private toResult = (raw: unknown): IMangaResult | null => {
    const row = asRecord(raw);
    const slug = asString(row?.slug);
    if (!row || slug === undefined) return null;

    const latest = asArray(row.latest_chapters)
      .map(c => asNumber(asRecord(c)?.number))
      .filter((n): n is number => n !== undefined);

    return {
      id: slug,
      title: asString(row.title) ?? slug,
      altTitles: asArray(row.alt_titles).filter((t): t is string => typeof t === 'string'),
      // list rows say `cover`, recommendation rows say `cover_url` — same CDN url either way
      image: asString(row.cover) ?? asString(row.cover_url),
      status: AsuraScans.toMediaStatus(asString(row.status)),
      type: asString(row.type),
      rating: asNumber(row.rating),
      chapterCount: asNumber(row.chapter_count),
      latestChapter: latest.length > 0 ? String(Math.max(...latest)) : undefined,
      url: `${this.baseUrl}${asString(row.public_url) ?? `/comics/${slug}`}`,
    };
  };

  /**
   * A `ChapterStub` from `/chapters`.
   *
   * `readable` and `externalUrl` are the house flags wave 1 established on MangaDex and the ones
   * `manga-aggregator.chapterUnavailability` actually reads today — without them the aggregator
   * cannot see a locked chapter and hands it back as readable. `isLocked`/`isPremium`/`unlockTime`
   * carry the finer distinction the aggregator's own `IChapterUnavailable` already types
   * (`'locked'` / `'premium'`) but has no source for yet.
   *
   * Only `is_locked` gates `readable`. `is_premium` is set on early-access chapters and observed
   * only alongside `is_locked`, but absence of evidence is not evidence: a premium chapter whose
   * window has expired must not be hidden, so it is reported and left readable.
   */
  private toChapter = (raw: unknown, seriesSlug: string): IMangaChapter | null => {
    const c = asRecord(raw);
    const number = asNumber(c?.number);
    if (!c || number === undefined) return null;

    const locked = c.is_locked === true;
    const chapterNumber = String(number);
    const title = asString(c.title);

    return {
      id: `${seriesSlug}/chapter/${chapterNumber}`,
      title: title ?? `Chapter ${chapterNumber}`,
      chapterNumber,
      // the listing reports 0 pages for a locked chapter; do not present that as a real count
      pages: locked ? 0 : asNumber(c.page_count),
      releaseDate: asString(c.published_at),
      views: asNumber(c.view_count),
      isLocked: locked,
      isPremium: c.is_premium === true,
      unlockTime: asString(c.unlock_time) ?? asString(c.early_access_until),
      /** false => {@link fetchChapterPages} will throw for this id. */
      readable: !locked,
      externalUrl: locked ? `${this.baseUrl}/comics/${seriesSlug}/chapter/${chapterNumber}` : null,
    };
  };

  /**
   * The five values the catalogue actually uses, counted over it: `ongoing`, `dropped`, `hiatus`,
   * `completed`, `axed`. The old mapper knew three and silently answered UNKNOWN for the ~40% of
   * the catalogue that is dropped/hiatus/axed.
   */
  private static toMediaStatus(status: string | undefined): MediaStatus {
    switch (status?.toLowerCase().trim()) {
      case 'ongoing':
        return MediaStatus.ONGOING;
      case 'completed':
        return MediaStatus.COMPLETED;
      case 'hiatus':
        return MediaStatus.HIATUS;
      case 'dropped':
      case 'axed':
      case 'cancelled':
      case 'canceled':
        return MediaStatus.CANCELLED;
      default:
        return MediaStatus.UNKNOWN;
    }
  }

  // -------------------------------------------------------------------------------- transport

  /** One GET, one place that turns an axios rejection into an error that names the host and path. */
  private getJson = async (url: string): Promise<unknown> => {
    try {
      const { data } = await this.client.get(url, { headers: this.headers });
      return data as unknown;
    } catch (err) {
      const status = (err as AxiosError).response?.status;
      const detail = asString(asRecord((err as AxiosError).response?.data)?.error);
      throw new Error(
        `[${this.name}] GET ${url} failed` +
          (status === undefined ? '' : ` with HTTP ${status}`) +
          (detail === undefined ? `: ${(err as Error).message}` : `: ${detail}`)
      );
    }
  };
}

/**
 * Distinguishes "this chapter is gated" from "the request broke", so
 * {@link AsuraScans.fetchChapterPages} does not waste an HTML request re-confirming a lock the API
 * already reported — and so the HTML fallback cannot mask one.
 */
class ChapterLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChapterLockedError';
  }
}

// ---------------------------------------------------------------------------- narrowing helpers
// `strict: true`: the API is `unknown` and gets narrowed, never cast. A shape change then yields a
// missing field, not a TypeError three frames away.

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Split any of `<slug>`, `/comics/<slug>/…`, `https://host/comics/<slug>/…` into path segments. */
const pathSegments = (raw: string): string[] => {
  let path = raw.trim();
  const scheme = path.match(/^https?:\/\/[^/]+/i);
  if (scheme) path = path.slice(scheme[0].length);
  return path
    .split(/[?#]/)[0]
    .split('/')
    .map(s => s.trim())
    .filter(s => s !== '');
};

/**
 * The API ships `description` as HTML (`<p>…</p><p>…</p>`). Flatten it to text, but turn block
 * boundaries into newlines first — `load(html).text()` alone welds paragraphs into one run-on word.
 */
const htmlToText = (html: string): string =>
  load(
    html
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote)\s*>/gi, '\n')
  )
    .root()
    .text()
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export default AsuraScans;
