/**
 * FlameComics — `flamecomics.xyz`.
 *
 * WHY THIS FILE IS A REWRITE AND NOT A SELECTOR PATCH.
 *
 * `flamescans.org`, the host this provider used to point at, is NOT FlameScans any more. It is a
 * parked ad-monetization domain: every path under it returns the same ~480-byte HTML stub, served by
 * `Cowboy`, which JS-redirects through a Joken JWT to a traffic broker. The lethal detail is that
 * the stub is **HTTP 200**, so axios does not throw and the old MangaThemesia selectors below simply
 * matched nothing. `search`, `fetchMangaInfo` and `fetchChapterPages` all "succeeded" and returned
 * `[]` / an empty info block. That is the exact fail-open shape four other providers were deleted
 * for; here the service is genuinely alive, so it is repaired rather than retired.
 *
 * The surviving service is a **Next.js** application at `flamecomics.xyz` (`flamecomics.com` 301s
 * there). Nothing about the WordPress/MangaThemesia model survives: there is no `.listupd .bs .bsx`,
 * no `#chapterlist li`, no `div#readerarea img`. The reader markup is built in the browser from
 * `__NEXT_DATA__`, so a cheerio pass over the delivered HTML finds zero `<img>` for a chapter's
 * pages. Everything below reads the embedded JSON instead.
 *
 * IDS CHANGED SHAPE, AND OLD IDS ARE NOT CONVERTIBLE.
 *
 *   manga id    a numeric `series_id` — "104", not a slug. The old provider's ids were WordPress
 *               slugs (`the-tyrant-of-defense-game`). There is no slug route on flamecomics.xyz and
 *               no mapping table, so ANY id persisted from the old provider is dead data.
 *   chapter id  `"{series_id}/{token}"`, e.g. `"104/0195c1a6f06c7d77"`. The token is an opaque
 *               16-hex-char per-chapter key. It is COMPOSITE on purpose: a token is scoped to its
 *               series, verified live — `/series/2/0195c1a6f06c7d77` and
 *               `/series/162/0195c1a6f06c7d77` both 404 while `/series/104/0195c1a6f06c7d77` is 200
 *               — so a bare token cannot address a chapter and `fetchChapterPages` takes exactly one
 *               string.
 *
 * WHAT WAS OBSERVED LIVE (flamecomics.xyz, 2026-08-14, residential egress, plain HTTP, no
 * Cloudflare interstitial, honest `Consumet/1.0` UA — no browser impersonation needed anywhere):
 *
 *   /browse                        pageProps.series — the WHOLE catalogue, 166 entries, in one
 *                                  document. There is no server-side search: `/browse?search=solo`
 *                                  returns byte-identical HTML to `/browse`, so filtering is the
 *                                  client's job and therefore ours.
 *   /series/{id}                   pageProps.series + pageProps.chapters (194 for id 104)
 *   /series/{id}/{token}           pageProps.chapter, incl. `images`
 *   bogus ids                      /series/999999, /series/notanumber and /series/104/deadbeef…
 *                                  all HTTP **404**. This host does not fail open — that is what
 *                                  makes it repairable, and the tests below pin it.
 *
 * THE `images` TRAP. `pageProps.chapter.images` is an **index-keyed OBJECT**, not an array:
 * `{"0":{name,size,type,width,height,modified},"1":{…}}`. `.map` is not available on it, and while
 * V8 happens to enumerate integer-like keys in ascending numeric order, that is a property of the
 * key strings rather than a guarantee about this payload — a single `"01"` or `"10a"` would silently
 * reorder a chapter. {@link FlameComics.orderedImages} sorts by NUMERIC key explicitly.
 *
 * TWO FIELDS ARE POLYMORPHIC ACROSS SERIES. Both seen live in the same week:
 *   `images[n].type`   `["image/jpeg"]` on series 104, `"image/jpeg"` on series 162.
 *   `pageProps.previous`  a token string mid-series, `null` on the first chapter.
 * Nothing here depends on `type`, and `previous`/`next` are normalised to `string | null`.
 *
 * PAGE IMAGES ARE ENORMOUS — see {@link FlameComics.fetchChapterPages}.
 */

import {
  IMangaChapter,
  IMangaChapterPage,
  IMangaInfo,
  IMangaResult,
  ISearch,
  MangaParser,
  MediaStatus,
} from '../../models';
import { extractEmbeddedJson } from '../../utils/embedded-json';

/**
 * Where the page bytes live. Derived, not guessed — the chapter-cover `<img>` tags that ARE
 * server-rendered on `/series/{id}` point at
 * `https://cdn.flamecomics.xyz/uploads/images/series/104/{token}/cover.png?{edit_time}`, and the
 * same `{series_id}/{token}/{name}` layout serves the page images that `images[n].name` names.
 * Confirmed by size, not just by status: `…/series/104/0195c1a6f06c7d77/TTDG1-01.jpg` returns
 * exactly 808,044 bytes of `image/jpeg`, which is byte-for-byte the `size` its metadata declares.
 * A name that does not exist 404s (146 bytes of HTML), so the CDN does not fail open either.
 */
const CDN_BASE = 'https://cdn.flamecomics.xyz/uploads/images/series';

/** How many search hits a page holds when the caller does not say. */
const DEFAULT_SEARCH_LIMIT = 20;

/* ------------------------------------------------------------------ *
 * narrowing helpers — `extractEmbeddedJson` hands back `unknown` by design, and this file is
 * compiled under `strict: true`. Everything below NARROWS. Nothing casts.
 * ------------------------------------------------------------------ */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** a non-empty trimmed string, or undefined — so a `""` field never becomes a "present" value */
const asText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** a finite number, whether the site sent `104` or `"104"` */
const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

/** the non-empty strings in an array field, tolerating `[""]` — which FlameComics does emit for
 *  `artist` on prose entries — and any non-array shape */
const asTextList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(asText).filter((item): item is string => item !== undefined) : [];

/** unix seconds → ISO date, the only date format the IManga* types carry */
const asIsoDate = (value: unknown): string | undefined => {
  const seconds = asNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/**
 * FlameComics' six status strings → the six-value {@link MediaStatus}. `Dropped` maps to CANCELLED
 * (the old provider did the same) and `Coming Soon` to NOT_YET_AIRED, which is the enum's only
 * "announced, nothing published" member. Observed distribution over the 166-entry catalogue:
 * Ongoing 44, Dropped 79, Hiatus 20, Completed 20, Cancelled 2, Coming Soon 1.
 */
const STATUS_BY_LABEL: ReadonlyMap<string, MediaStatus> = new Map([
  ['ongoing', MediaStatus.ONGOING],
  ['completed', MediaStatus.COMPLETED],
  ['hiatus', MediaStatus.HIATUS],
  ['dropped', MediaStatus.CANCELLED],
  ['cancelled', MediaStatus.CANCELLED],
  ['canceled', MediaStatus.CANCELLED],
  ['coming soon', MediaStatus.NOT_YET_AIRED],
]);

const asStatus = (value: unknown): MediaStatus =>
  STATUS_BY_LABEL.get((asText(value) ?? '').toLowerCase()) ?? MediaStatus.UNKNOWN;

/** one entry of the index-keyed `images` object, after narrowing */
interface IFlameImage {
  readonly name: string;
  readonly width?: number;
  readonly height?: number;
  readonly size?: number;
}

class FlameComics extends MangaParser {
  /**
   * The service's real name. The registry key in `providers/manga/index.ts` and therefore
   * {@link classPath} stay `FlameScans` — renaming those is an API-visible change that belongs with
   * whoever owns that file, not here.
   */
  override readonly name = 'FlameComics';
  protected override baseUrl = 'https://flamecomics.xyz';
  protected override logo = 'https://flamecomics.xyz/favicon.ico';
  protected override classPath = 'MANGA.FlameScans';

  /**
   * Next.js' per-deploy build hash, learned from a page we already had to fetch.
   *
   * WHY BOTHER. Every route on this site also exists as a JSON endpoint at
   * `/_next/data/{buildId}{path}.json`, carrying the identical `pageProps` for a fraction of the
   * bytes — measured live: `/browse` 1,510,199 B of HTML vs 103,161 B of JSON, `/series/104`
   * 584,544 B vs 32,738 B, one chapter 79,448 B vs 5,105 B. That is a 15-18x saving on every call,
   * and search has to pull the entire catalogue.
   *
   * WHY IT IS SAFE. `buildId` changes on every deploy, and a stale one is not a silent wrong answer
   * — it is a clean **404** (verified: `/_next/data/BOGUSBUILDID/browse.json` → 404). So the JSON
   * route is only ever an optimisation: any failure falls through to the HTML page, which both
   * answers the question AND re-learns the current `buildId`. Cold start costs one HTML fetch.
   * Deliberately NOT cached: the catalogue and chapter lists themselves, only this hash.
   */
  private buildId?: string;

  /**
   * The `pageProps` for a site path, by whichever of the two routes is available.
   *
   * Both routes are the same data — `/_next/data/…json` is `{__N_SSG, pageProps}` and the HTML page
   * is `__NEXT_DATA__.props.pageProps` — verified field-identical for a chapter, down to the image
   * metadata. A 404 from either propagates as a thrown axios error, which is the point: a missing
   * series must not read as an empty one.
   */
  private fetchPageProps = async (path: string): Promise<Record<string, unknown>> => {
    if (this.buildId !== undefined) {
      try {
        const { data } = await this.client.get(`${this.baseUrl}/_next/data/${this.buildId}${path}.json`);
        const props = isRecord(data) ? data.pageProps : undefined;
        if (isRecord(props)) return props;
      } catch {
        // a rotated buildId (404), or a route Next.js does not serve as data. Either way the HTML
        // page below is authoritative and refreshes the hash. Never let this hide a real fault:
        // if the site is actually down, the HTML fetch throws and THAT error is what surfaces.
      }
    }

    const url = `${this.baseUrl}${path}`;
    const { data } = await this.client.get(url, { responseType: 'text' });
    const next = extractEmbeddedJson(data, { shapes: ['next-data'], source: url });

    if (!isRecord(next)) throw new Error(`[${this.name}] __NEXT_DATA__ at ${url} is not an object`);
    const buildId = asText(next.buildId);
    if (buildId !== undefined) this.buildId = buildId;

    const props = isRecord(next.props) ? next.props.pageProps : undefined;
    if (!isRecord(props)) throw new Error(`[${this.name}] no props.pageProps in __NEXT_DATA__ at ${url}`);
    return props;
  };

  /**
   * Search the catalogue.
   *
   * There is no server-side search to call: `/browse` ignores its query string and ships all 166
   * series in one payload, so matching happens here. Substring, case-insensitive, over the title —
   * `/browse` entries carry no `altTitles` (only `/series/{id}` does), so there is nothing else to
   * match on and no pretence that there is.
   *
   * PROSE ENTRIES ARE EXCLUDED, and this is the one thing in this method that must not be
   * simplified. 13 of the 166 catalogue entries are novels ("Novel" / "Web Novel"), and a novel
   * entry has **no `series_id` field at all** — it carries `novel_id` and lives at `/novel/{id}`,
   * a different route with a different `pageProps` shape and no page images anywhere. A naive
   * `String(entry.series_id)` yields the literal string `"undefined"` for every one of them, i.e. 13
   * search hits whose id 404s on the very next call. They are dropped by requiring `series_id`.
   */
  override search = async (
    query: string,
    page: number = 1,
    limit: number = DEFAULT_SEARCH_LIMIT
  ): Promise<ISearch<IMangaResult>> => {
    if (!Number.isInteger(page) || page < 1) throw new Error(`[${this.name}] page must be an integer >= 1`);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`[${this.name}] limit must be an integer >= 1`);

    const needle = query.trim().toLowerCase();
    if (needle === '') throw new Error(`[${this.name}] search query must not be empty`);

    const props = await this.fetchPageProps('/browse');
    const series = props.series;
    if (!Array.isArray(series))
      // The catalogue is the ONE thing this page exists to carry. Absent means the page changed
      // shape (or we were served something else) — never "no results".
      throw new Error(
        `[${this.name}] /browse carried no series catalogue — the page shape changed, or the ` +
          `response was not the browse page`
      );

    const matches: IMangaResult[] = [];
    for (const entry of series) {
      if (!isRecord(entry)) continue;
      const seriesId = asNumber(entry.series_id);
      const title = asText(entry.title);
      // no series_id => a novel (or a shape we do not understand). Emitting it would hand the caller
      // an id that cannot be fetched.
      if (seriesId === undefined || title === undefined) continue;
      if (!title.toLowerCase().includes(needle)) continue;

      matches.push({
        id: String(seriesId),
        title,
        image: this.coverUrl(seriesId, entry.cover),
        description: asText(entry.description),
        status: asStatus(entry.status),
        releaseDate: asNumber(entry.year),
        genres: asTextList(entry.categories),
        authors: asTextList(entry.author),
        artist: asTextList(entry.artist),
        type: asText(entry.type),
      });
    }

    const start = (page - 1) * limit;
    return {
      currentPage: page,
      hasNextPage: start + limit < matches.length,
      totalPages: Math.max(1, Math.ceil(matches.length / limit)),
      totalResults: matches.length,
      results: matches.slice(start, start + limit),
    };
  };

  /**
   * Series metadata and the full chapter list for a numeric `series_id`.
   *
   * `chapters` is newest-first as delivered and is left that way. Each entry's `id` is the composite
   * `"{series_id}/{token}"` that {@link fetchChapterPages} expects — see the ID note at the top of
   * this file for why a bare token will not do.
   *
   * NO READABILITY FLAG, AND THAT IS A FINDING, NOT AN OMISSION. mangadex.ts pre-flags chapters with
   * `readable: false` because MangaDex indexes chapters whose images it does not hold. FlameComics
   * has no equivalent per-chapter state: the listing exposes `notice`, which is **0 on all 1,678
   * chapters across the nine series sampled**, and `draft`/`hidden` are not on the listing records
   * at all (they appear on the chapter document, 0/0 where seen) — unpublished chapters are simply
   * absent from the list rather than present-and-unreadable. Inventing a `readable` field here would
   * be a flag that never goes false. The two real "nothing to read" states live at series level, not
   * chapter level, and both are visible without a flag: a **novel** is not reachable through this
   * provider at all (see {@link search}), and a **`Coming Soon` series has zero chapters** — id 35,
   * "The Little Prince in the Ossuary", is HTTP 200 with `chapters: []`, which `chapters.length === 0`
   * already tells the caller.
   */
  override fetchMangaInfo = async (mangaId: string): Promise<IMangaInfo> => {
    const seriesId = this.requireSeriesId(mangaId);
    const props = await this.fetchPageProps(`/series/${seriesId}`);

    const series = props.series;
    if (!isRecord(series))
      throw new Error(`[${this.name}] /series/${seriesId} carried no series record — page shape changed`);

    const title = asText(series.title);
    if (title === undefined)
      throw new Error(`[${this.name}] /series/${seriesId} carried a series record with no title`);

    const rawChapters = Array.isArray(props.chapters) ? props.chapters : [];
    const chapters: IMangaChapter[] = [];
    for (const entry of rawChapters) {
      if (!isRecord(entry)) continue;
      const token = asText(entry.token);
      // Without a token the chapter has no address. Skipping is right: the rest of the list is
      // still usable, and a `""` id would 404 on read.
      if (token === undefined) continue;
      const chapterNumber = asText(entry.chapter) ?? asText(entry.chapter_id);
      chapters.push({
        id: `${seriesId}/${token}`,
        title: asText(entry.title) ?? (chapterNumber !== undefined ? `Chapter ${chapterNumber}` : token),
        chapterNumber,
        releaseDate: asIsoDate(entry.release_date),
      });
    }

    return {
      id: String(seriesId),
      title,
      altTitles: asTextList(series.altTitles),
      // `description` is an HTML fragment on the series route ("<p>…</p>") but plain text on the
      // chapter route. Tags are stripped so one provider does not emit two description formats.
      description: stripHtml(asText(series.description)),
      image: this.coverUrl(seriesId, series.cover),
      status: asStatus(series.status),
      releaseDate: asNumber(series.year),
      genres: asTextList(series.tags),
      authors: asTextList(series.author),
      artist: asTextList(series.artist),
      publishers: asTextList(series.publisher),
      type: asText(series.type),
      chapters,
    };
  };

  /**
   * The page images for `"{series_id}/{token}"`.
   *
   * SIZE WARNING FOR THE API LAYER — these are not ordinary manga pages. FlameComics serves
   * long-strip webtoons as very tall JPEGs: series 162 chapter 30 is 16 pages totalling
   * **59,623,645 bytes (56.9 MiB)**, its largest single page 5,691,608 bytes at 800x15746, and
   * triage measured a 3,513,015-byte page at 800x11886 elsewhere. Anything that proxies, buffers or
   * caches these needs to expect tens of megabytes per chapter. No cap is imposed here — truncating
   * a chapter would be a silent wrong answer, and the right place to decide is the layer that knows
   * its own memory budget. `width`/`height`/`size` are passed through per page so that layer can
   * decide BEFORE fetching. The CDN honours range requests (verified: HTTP 206), so a caller that
   * must stream can.
   *
   * NO `headerForImage`, DELIBERATELY. The CDN has no hotlink protection: the page above returns
   * 200 with no `Referer` at all, under an honest `Consumet/1.0` UA and under a browser UA alike.
   * mangapill/mangasee123/mangakakalot attach a `Referer` because their CDNs 403 without one; adding
   * a header this host does not want would be cargo cult.
   *
   * Throws rather than returning `[]` when a chapter has no images, matching the convention
   * mangadex.ts sets — an empty array reads as a successful zero-page chapter and renders as a blank
   * reader, and an aggregator's per-provider fallthrough keys on the throw.
   */
  override fetchChapterPages = async (chapterId: string): Promise<IMangaChapterPage[]> => {
    const { seriesId, token } = this.parseChapterId(chapterId);
    const props = await this.fetchPageProps(`/series/${seriesId}/${token}`);

    const chapter = props.chapter;
    if (!isRecord(chapter))
      throw new Error(`[${this.name}] chapter ${chapterId} carried no chapter record — page shape changed`);

    const images = this.orderedImages(chapter.images, chapterId);

    return images.map((image, index) => ({
      // encoded because `name` is a remote-chosen path segment: a name containing `/` or `..` would
      // otherwise let the site steer the request off the chapter's own CDN prefix.
      img: `${CDN_BASE}/${seriesId}/${token}/${encodeURIComponent(image.name)}`,
      page: index,
      width: image.width,
      height: image.height,
      size: image.size,
    }));
  };

  /**
   * `images` (index-keyed object) → an array in numeric page order.
   *
   * The explicit numeric sort is the whole point: the payload is an OBJECT whose keys happen to be
   * `"0"`…`"n"`, and relying on enumeration order makes correct page order an accident of how the
   * keys are spelled. Non-numeric keys are ignored — they are not pages — but a chapter with no
   * numeric keys at all, or with an entry that has no `name` to build a URL from, is a fault and
   * throws.
   */
  private orderedImages = (images: unknown, chapterId: string): IFlameImage[] => {
    if (!isRecord(images))
      throw new Error(
        `[${this.name}] chapter ${chapterId} has no images object — FlameComics delivers pages as ` +
          `an index-keyed object under props.pageProps.chapter.images`
      );

    const keys = Object.keys(images)
      .filter(key => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b));

    if (keys.length === 0)
      throw new Error(
        `[${this.name}] chapter ${chapterId} is not readable — its images object holds no numbered ` +
          `pages. The chapter page loaded, so this is an empty or withheld chapter upstream, not a ` +
          `network fault.`
      );

    return keys.map(key => {
      const entry = images[key];
      const name = isRecord(entry) ? asText(entry.name) : undefined;
      if (name === undefined)
        throw new Error(
          `[${this.name}] chapter ${chapterId} page ${key} has no file name — cannot build its CDN URL`
        );
      return {
        name,
        width: isRecord(entry) ? asNumber(entry.width) : undefined,
        height: isRecord(entry) ? asNumber(entry.height) : undefined,
        size: isRecord(entry) ? asNumber(entry.size) : undefined,
      };
    });
  };

  /**
   * `{series_id}/{token}` → its parts.
   *
   * Rejects anything else loudly instead of pasting it into a URL, because the ids this provider
   * USED to mint were WordPress slugs and there is no route on flamecomics.xyz that would turn one
   * into anything but a 404. A caller holding persisted old ids deserves to be told what shape is
   * expected, not handed a network error.
   */
  private parseChapterId = (chapterId: string): { seriesId: number; token: string } => {
    const match = /^(\d+)\/([A-Za-z0-9]+)$/.exec(chapterId.trim());
    if (match === null)
      throw new Error(
        `[${this.name}] invalid chapter id "${chapterId}" — expected "{series_id}/{token}", e.g. ` +
          `"104/0195c1a6f06c7d77". FlameComics chapter tokens are series-scoped, so the series id is ` +
          `part of the id. Ids from the old flamescans.org provider were slugs and cannot be converted.`
      );
    return { seriesId: Number(match[1]), token: match[2] };
  };

  /** a manga id must be the numeric `series_id`; a slug is an old-provider id and cannot be resolved */
  private requireSeriesId = (mangaId: string): number => {
    const trimmed = mangaId.trim();
    if (!/^\d+$/.test(trimmed))
      throw new Error(
        `[${this.name}] invalid manga id "${mangaId}" — FlameComics series ids are numeric, e.g. "104". ` +
          `Slug ids from the old flamescans.org provider cannot be converted; re-search for the title.`
      );
    return Number(trimmed);
  };

  /**
   * Series cover URL. `cover` is a bare file name (`thumbnail.webp` / `.png` / `.jpg` / `.jpeg`,
   * all four present in the catalogue), living one level above the chapter folders — verified:
   * `…/series/104/thumbnail.jpg` returns 674,297 bytes of `image/jpeg`.
   */
  private coverUrl = (seriesId: number, cover: unknown): string | undefined => {
    const name = asText(cover);
    return name === undefined ? undefined : `${CDN_BASE}/${seriesId}/${encodeURIComponent(name)}`;
  };
}

/**
 * Strip tags from the series-route description.
 *
 * Not a sanitiser and not trying to be — it exists so the two routes do not emit two different
 * description formats. Tag removal is done on a character scan rather than a `<[^>]*>` regex so
 * nested or unclosed angle brackets cannot leave a fragment behind, and the four entities
 * FlameComics actually emits are decoded.
 */
function stripHtml(html: string | undefined): string | undefined {
  if (html === undefined) return undefined;

  let text = '';
  let depth = 0;
  for (const char of html) {
    if (char === '<') depth++;
    else if (char === '>') {
      if (depth > 0) depth--;
    } else if (depth === 0) text += char;
  }

  const decoded = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // last, so an escaped entity such as `&amp;lt;` does not become a tag-looking `<`
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  return decoded.length > 0 ? decoded : undefined;
}

export default FlameComics;
