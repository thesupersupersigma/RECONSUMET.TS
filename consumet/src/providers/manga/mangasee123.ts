import { load, CheerioAPI, Cheerio } from 'cheerio';
import { AnyNode } from 'domhandler';

import {
  MangaParser,
  ISearch,
  IMangaInfo,
  IMangaResult,
  IMangaChapterPage,
  IMangaChapter,
  MediaStatus,
} from '../../models';
import { USER_AGENT } from '../../utils';

/**
 * WeebCentral — the successor to MangaSee123 / MangaLife.
 *
 * WHY THE CLASS IS STILL CALLED `Mangasee123`. `mangasee123.com` is dead: its authoritative
 * nameservers are `ns1/ns2.parklogic.com` and EVERY path — including deliberately bogus ones —
 * answers 200 with the same ~4.7 KB ad-monetisation "Redirecting..." interstitial. A naive uptime
 * check sees 200 everywhere and calls the provider healthy, which is exactly how this stayed
 * "working" long after it stopped working. Sister domain `mangalife.us` is parked by the same
 * operator; `manga4life.com` no longer resolves at all. The whole portfolio is gone.
 *
 * WeebCentral is where that library moved — same cover CDN (`temp.compsci88.com`), same page CDNs
 * (`*.lowee.us`, `*.planeptune.us`) — so the class name, `classPath` and the default export are
 * kept verbatim so `MANGA.Mangasee123` keeps resolving for existing callers and route tables.
 * Only `name` changed, and that field is display-only (see `BaseProvider.toString`).
 *
 * WHAT CHANGED STRUCTURALLY. MangaSee was a single-page app whose entire state sat in inline
 * `vm.*` JS globals. WeebCentral is server-rendered HTML plus htmx partials and has **no embedded
 * JSON at all** — the shared `extractEmbeddedJson` helper correctly reports 'not-found' on every
 * one of its pages (its only inline array, `var readingStylesWithPage = [...]`, is valid JS but
 * not JSON). So this file is plain cheerio, deliberately. Do not reach for the helper here.
 *
 * THE PAGE-IMAGE SCHEME IS THE BIG WIN. The legacy provider read the CDN host out of
 * `vm.CurPathName` and then *constructed* filenames by zero-padding a page counter, because
 * MangaSee never served a list. WeebCentral serves a real `<img>` list, and it must be used:
 * the CDN host varies per series (Goodnight Punpun is on `official.lowee.us`, One Piece is on
 * `hot.planeptune.us` — both re-confirmed live 2026-08-14), so there is no host to pin and no
 * filename to construct. Read the list; never build a URL. The planeptune host in particular has
 * rotated before (it was `scans-hot.planeptune.us`), which is exactly why it is never hardcoded.
 */
class Mangasee123 extends MangaParser {
  override readonly name = 'WeebCentral';
  protected override baseUrl = 'https://weebcentral.com';
  protected override logo = 'https://weebcentral.com/static/images/apple-touch-icon.png';
  /** unchanged on purpose — `MANGA.Mangasee123` is a public entry point. */
  protected override classPath = 'MANGA.Mangasee123';

  /** WeebCentral ids are ULIDs: 26 chars, Crockford base32, no I/L/O/U. */
  private static readonly ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

  /**
   * `/search/data` returns 32 results per request and **the `limit` parameter does not work**.
   * Measured live against `text=a`, unique series per response:
   *
   *   limit=5 -> 32   limit=10 -> 32   limit=24 -> 32
   *   limit=32 -> 32  limit=50 -> 32   limit=100 -> 32   limit=200 -> 32
   *
   * `offset` genuinely works, so paging does. The page size is therefore pinned here rather than
   * exposed as an argument: a `limit` parameter callers can set but the server ignores produces
   * silently overlapping pages (asking for limit=5 and stepping offset by 5 re-returns 27 of the
   * previous 32 — observed before this was pinned).
   */
  private static readonly PAGE_SIZE = 32;

  /**
   * WeebCentral sits behind Cloudflare with a **UA blocklist**, and the axios default UA is on it.
   * Measured live, same URL, seconds apart:
   *
   *   (no User-Agent header) -> 403
   *   `axios/1.6.7`          -> 403   <-- what this client sends if we do nothing
   *   `curl/8.7.1`           -> 403
   *   `Consumet/1.0`         -> 200
   *   the shared USER_AGENT  -> 200
   *
   * Note this is NOT the ComicK failure mode (there, a browser-claiming UA from a non-browser TLS
   * stack is what trips the rule, and an honest `Consumet/1.0` is the *fix*). Here both an honest
   * UA and a browser UA pass and only known bot-tool UAs are refused, so escalating the disguise
   * would buy nothing. The shared constant is used because it is the repo convention and because
   * `Consumet/1.0` is precisely the kind of string that gets added to such a blocklist later.
   */
  private get headers(): Record<string, string> {
    return { 'User-Agent': USER_AGENT, Referer: `${this.baseUrl}/` };
  }

  /**
   * GET that refuses to be fooled by WeebCentral's redirect-to-a-200-error-page behaviour.
   *
   * An unknown series id 307s to `/404` and an unknown/malformed chapter id 307s to `/400`, and
   * **both of those pages answer 200**. With axios's default redirect following, a garbage id
   * therefore comes back as a perfectly healthy-looking 200 full of unrelated HTML, and every
   * selector below silently yields nothing — the same "200 means healthy" trap the dead
   * mangasee123.com parking page sets. Suppressing redirects turns that into an explicit,
   * greppable failure at the exact request that caused it.
   *
   * This is also why the check is a status check and not a body sniff: it is deterministic, it
   * costs no extra request, and it is reproducible offline by a fake adapter.
   */
  private fetch = async (url: string): Promise<string> => {
    const res = await this.client.get(url, {
      headers: this.headers,
      // do not follow: a 3xx here is the *answer*, not a detour.
      maxRedirects: 0,
      validateStatus: () => true,
    });

    const status = res.status ?? 200;
    if (status >= 300 && status < 400) {
      const to = String(res.headers?.location ?? res.headers?.Location ?? '');
      throw new Error(
        `[${this.name}] ${url} redirected (${status}${to ? ` -> ${to}` : ''}). WeebCentral bounces ` +
          `unknown series ids to /404 and unknown or malformed chapter ids to /400, and BOTH of ` +
          `those pages return HTTP 200 — so this is a not-found, not a transport error. Check the ` +
          `id is a 26-character ULID that still exists.`
      );
    }
    if (status < 200 || status >= 300)
      throw new Error(
        `[${this.name}] ${url} returned HTTP ${status}.` +
          (status === 403
            ? ' A 403 here is the Cloudflare UA blocklist — confirm a User-Agent header is actually' +
              ' being sent, since the axios default (`axios/x.y.z`) is refused.'
            : '')
      );

    return res.data as string;
  };

  /**
   * Pull the value out of WeebCentral's `<strong>Label:</strong> value` detail rows.
   *
   * These rows are matched by their LABEL TEXT, not by class, because the markup is Tailwind —
   * the class attribute is styling that changes on any redesign, whereas "Author(s):" is content.
   * Pinning `.text-sm.opacity-70` here would be the same brittleness that killed the old
   * `body > script:nth-child(15)` selectors this file used to carry.
   *
   * `label` is matched as a prefix, case-insensitively, because the site is not internally
   * consistent: the series page says "Tags(s):" (sic) and the search card says "Tag(s):".
   */
  private detailRow = ($: CheerioAPI, scope: Cheerio<AnyNode>, label: string): Cheerio<AnyNode> => {
    const want = label.toLowerCase();
    return scope
      .find('strong')
      .filter((_, el) => $(el).text().trim().toLowerCase().startsWith(want))
      .first()
      .parent();
  };

  /** text of a detail row with its `<strong>` label removed */
  private detailValue = ($: CheerioAPI, scope: Cheerio<AnyNode>, label: string): string => {
    const row = this.detailRow($, scope, label);
    if (row.length === 0) return '';
    const clone = row.clone();
    clone.find('strong').remove();
    return clone.text().replace(/\s+/g, ' ').trim();
  };

  /** WeebCentral's own status vocabulary, taken from the search form's `included_status` values. */
  private toMediaStatus = (raw: string): MediaStatus => {
    switch (raw.trim().toLowerCase()) {
      case 'ongoing':
        return MediaStatus.ONGOING;
      case 'complete':
      case 'completed':
        return MediaStatus.COMPLETED;
      case 'hiatus':
        return MediaStatus.HIATUS;
      // the site spells it "Canceled"; accept both so a copy-edit upstream cannot break this.
      case 'canceled':
      case 'cancelled':
        return MediaStatus.CANCELLED;
      default:
        return MediaStatus.UNKNOWN;
    }
  };

  /**
   * Accept anything a caller might plausibly hold and reduce it to the bare ULID.
   *
   * Ids appear in the wild as `01J76XYA2AFH8MNBG4FRCM5JMV`, as `<ULID>/Oyasumi-Punpun`, and as a
   * full `https://weebcentral.com/series/<ULID>/<Slug>` URL (that is the form the search HTML
   * actually contains). The slug is decorative — `/series/<ULID>` alone serves the identical
   * 76 KB page, confirmed live — so it is dropped rather than round-tripped.
   */
  private toUlid = (raw: string, kind: 'series' | 'chapter'): string => {
    const match = String(raw ?? '').match(Mangasee123.ULID);
    if (!match)
      throw new Error(
        `[${this.name}] "${raw}" is not a WeebCentral ${kind} id. WeebCentral identifies everything ` +
          `by 26-character ULID (e.g. 01J76XYA2AFH8MNBG4FRCM5JMV), not by the slug-and-chapter-number ` +
          `ids the old mangasee123.com provider used (e.g. "Yofukashi-no-Uta-chapter-1"). Those ids ` +
          `do not exist on this site; re-resolve them through search().`
      );
    return match[0];
  };

  /**
   * @param query search query
   * @param page 1-indexed page number (default 1). There is no `limit` argument on purpose — see
   *   {@link Mangasee123.PAGE_SIZE}; the server ignores `limit` and always returns 32.
   */
  override search = async (query: string, page: number = 1): Promise<ISearch<IMangaResult>> => {
    if (page < 1) throw new Error('Page number must be greater than 0');
    const size = Mangasee123.PAGE_SIZE;

    try {
      // `/search` itself is only a shell — it htmx-loads `/search/data`, which is the endpoint that
      // actually carries results and the one used here. `display_mode=Full Display` is sent
      // explicitly: the grid mode renders covers only, and the metadata parsed below would vanish.
      // Paging is offset-based; the site's own "load more" button emits
      // `/search/data?limit=32&offset=32&text=...`, which is the shape reproduced here.
      const params = new URLSearchParams({
        text: query,
        limit: String(size),
        offset: String((page - 1) * size),
        display_mode: 'Full Display',
      });
      const data = await this.fetch(`${this.baseUrl}/search/data?${params.toString()}`);
      const $ = load(data);

      // Anchor on the series link rather than on a card class: a no-results query returns a
      // `role="alert"` warning block with zero series links, so this naturally yields [].
      const seen = new Set<string>();
      const results: IMangaResult[] = [];

      $('article')
        .filter((_, el) => $(el).find('a[href*="/series/"]').length > 0)
        .each((_, el) => {
          const card = $(el);
          const href = card.find('a[href*="/series/"]').first().attr('href') ?? '';
          const id = href.match(Mangasee123.ULID)?.[0];
          if (!id || seen.has(id)) return; // the card links the same series several times over
          seen.add(id);

          // Title comes from the cover's `alt="<Title> cover"`, NOT from the first series anchor
          // with text. The mobile half of each card wraps the "Official"/"Adult" corner ribbon and
          // the title in the SAME anchor, so reading anchor text yields "Official Goodnight Punpun"
          // — that exact string came back from the live site before this was changed. The `alt` is
          // a single clean value and survives layout changes. The `line-clamp`/`link` anchor in the
          // desktop half is the fallback; it holds the bare title with no ribbon.
          const title =
            card
              .find('img[alt$=" cover"]')
              .first()
              .attr('alt')
              ?.replace(/ cover$/, '')
              .trim() ||
            card
              .find('a[href*="/series/"].link, a[href*="/series/"][class*="line-clamp"]')
              .map((__, a) => $(a).text().replace(/\s+/g, ' ').trim())
              .get()
              .find(t => t.length > 0) ||
            '';

          const result: IMangaResult = {
            id,
            title,
            // The `<source>` webp is the higher-quality asset; the `<img>` jpg is the fallback the
            // site ships for browsers without webp. Both were fetched live and are real images
            // (webp `RIFF....WEBP`, 15,940 B; jpg `ffd8ffe0`, 21,588 B).
            image:
              card.find('source[type="image/webp"]').first().attr('srcset') ??
              card.find('img[alt$=" cover"]').first().attr('src'),
            headerForImage: { Referer: `${this.baseUrl}/` },
          };

          const year = this.detailValue($, card, 'year');
          if (year) result.releaseDate = year;

          const status = this.detailValue($, card, 'status');
          if (status) result.status = this.toMediaStatus(status);

          const authors = this.detailRow($, card, 'author')
            .find('a')
            .map((__, a) => $(a).text().trim())
            .get()
            .filter(Boolean);
          if (authors.length) result.authors = authors;

          // Search cards render tags as bare `<span>Drama,</span>` (no links, trailing commas),
          // unlike the series page which links each one. Split on the comma the site emits.
          const tags = this.detailValue($, card, 'tag')
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);
          if (tags.length) result.genres = tags;

          results.push(result);
        });

      // The site emits its own "load more" control — `hx-get="/search/data?...offset=<next>"` —
      // exactly when another page exists, and omits it on the last page (confirmed live: present
      // for `text=a` at offset 0 and 32, absent for the single-result `text=punpun`). Reading that
      // is strictly better than inferring from `results.length === size`, which mis-reports a
      // result set whose total happens to be an exact multiple of the page size.
      const hasNextPage = $('[hx-get*="/search/data"]').length > 0;

      return { currentPage: page, hasNextPage, results };
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * @param mangaId a WeebCentral series ULID (a full series URL or `<ULID>/<Slug>` is also accepted)
   */
  override fetchMangaInfo = async (mangaId: string): Promise<IMangaInfo> => {
    const id = this.toUlid(mangaId, 'series');

    try {
      const [seriesHtml, chapterHtml] = await Promise.all([
        this.fetch(`${this.baseUrl}/series/${id}`),
        // MUST be a separate request. The series page embeds only the most recent handful of
        // chapters — 9 of Goodnight Punpun's 147, confirmed live — behind a "Show All Chapters"
        // button that htmx-gets this fragment. Parsing the series page alone silently truncates
        // every long-running series to its last few chapters, which looks like success.
        this.fetch(`${this.baseUrl}/series/${id}/full-chapter-list`),
      ]);

      const $ = load(seriesHtml);
      // Scope the detail lookups to <main> so the header/footer/login-modal markup cannot satisfy
      // them; fall back to <body> (never `$.root()`, whose Document node has no `.find` overload)
      // if the page ever drops the landmark.
      const info = $('main').length ? $('main') : $('body');

      const mangaInfo: IMangaInfo = {
        id,
        // Two h1s carry the title (one `md:hidden`, one `hidden md:block`); take the first with
        // text. og:title is the fallback and needs the site suffix stripped.
        title:
          $('h1')
            .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
            .get()
            .find(t => t.length > 0) ??
          $('meta[property="og:title"]').attr('content')?.replace(/\s*\|\s*Weeb Central\s*$/, '') ??
          '',
      };

      mangaInfo.image =
        $('meta[property="og:image"]').attr('content') ??
        info.find('source[type="image/webp"]').first().attr('srcset');
      mangaInfo.headerForImage = { Referer: `${this.baseUrl}/` };

      const description = this.detailRow($, info, 'description').find('p').text().replace(/\s+/g, ' ').trim();
      if (description) mangaInfo.description = description;

      const altTitles = this.detailRow($, info, 'associated name')
        .find('li')
        .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean);
      if (altTitles.length) mangaInfo.altTitles = altTitles;

      const authors = this.detailRow($, info, 'author')
        .find('a')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean);
      if (authors.length) mangaInfo.authors = authors;

      const genres = this.detailRow($, info, 'tag')
        .find('a')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean);
      if (genres.length) mangaInfo.genres = genres;

      mangaInfo.status = this.toMediaStatus(this.detailValue($, info, 'status'));

      const released = this.detailValue($, info, 'released');
      if (released) mangaInfo.releaseDate = released;

      // AniList / MangaUpdates / official-publisher links from the "Track:" row. Useful to the
      // aggregator for cross-provider identity; cheap to carry.
      const links = info
        .find('a[href^="http"]')
        .map((_, el) => $(el).attr('href') ?? '')
        .get()
        .filter(href => !href.includes('weebcentral.com') && !href.includes('compsci88.com'));
      if (links.length) mangaInfo.links = Array.from(new Set(links));

      mangaInfo.chapters = this.parseChapters(chapterHtml);

      return mangaInfo;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * Parse the `/series/<ULID>/full-chapter-list` fragment. It is HTML, not JSON — every row is an
   * `<a href="/chapters/<ULID>">` with the label in a `<span>` and the timestamp in `<time>`.
   */
  private parseChapters = (html: string): IMangaChapter[] => {
    const $ = load(html);

    return $('a[href*="/chapters/"]')
      .map((_, el): IMangaChapter | null => {
        const id = ($(el).attr('href') ?? '').match(Mangasee123.ULID)?.[0];
        if (!id) return null;

        // The row also carries `x-show`-gated "Last Read" / "new chapter" markers. Alpine hides
        // them in a browser, but they are still text in the source, so both the row's whole text
        // AND its first non-empty span (which is the *wrapper* `<span class="grow ...">`, an
        // ancestor of both the label and the marker) come back as "Chapter 147 Last Read" — that
        // exact string was returned by the live site before this was narrowed. Restricting to LEAF
        // spans skips every wrapper and lands on the bare "Chapter 147".
        const title =
          $(el)
            .find('span')
            .filter((__, s) => $(s).children().length === 0)
            .map((__, s) => $(s).text().replace(/\s+/g, ' ').trim())
            .get()
            .find(t => t.length > 0) ?? '';

        const chapter: IMangaChapter = { id, title };

        // The `datetime` attribute is a clean ISO-8601 Z value; the element's text is the raw
        // microsecond-precision database value. Prefer the attribute.
        const releaseDate = $(el).find('time').first().attr('datetime') ?? $(el).find('time').first().text().trim();
        if (releaseDate) chapter.releaseDate = releaseDate;

        return chapter;
      })
      .get()
      .filter((c): c is IMangaChapter => c !== null);
  };

  /**
   * @param chapterId a WeebCentral chapter ULID (a full chapter URL is also accepted)
   *
   * ON THE WAVE-1 UNREADABLE-CHAPTER CONVENTION (mangadex.ts): it does not apply here, and saying
   * so plainly is the honest answer rather than inventing a flag. MangaDex lists chapters it does
   * not host — licensed stubs carrying an `externalUrl` and `pages: 0` — so it can pre-flag them
   * `readable: false` on `fetchMangaInfo` and throw a specific error here. WeebCentral exposes no
   * equivalent state: the chapter list carries no availability field, and every chapter sampled
   * live returned a populated image list (8 chapters spread across One Piece's 1,190 returned
   * 13-26 pages each; none were empty). `readable`/`externalUrl` are therefore deliberately NOT
   * set — MangaAggregator treats their absence as "available", which matches reality. The
   * defensive throw below stays because an empty list is still a real failure mode if it appears.
   */
  override fetchChapterPages = async (chapterId: string): Promise<IMangaChapterPage[]> => {
    const id = this.toUlid(chapterId, 'chapter');

    try {
      // These query params are what the site's own reader sends. They were confirmed live to make
      // no difference — the endpoint returns the complete image list for `long_strip`,
      // `single_page`, an empty value, and no params at all — but they are sent anyway so a future
      // server-side tightening of the parameter contract does not break this silently.
      const params = new URLSearchParams({
        is_prev: 'False',
        current_page: '1',
        reading_style: 'long_strip',
      });
      const data = await this.fetch(`${this.baseUrl}/chapters/${id}/images?${params.toString()}`);
      const $ = load(data);

      const images = $('img')
        .map((_, el) => $(el).attr('src') ?? '')
        .get()
        // `/static/images/broken_image.jpg` is WeebCentral's client-side `onerror` placeholder and
        // is never a real page. Absolute http(s) only, so a relative UI asset cannot become a page.
        .filter(src => /^https?:\/\//.test(src) && !src.includes('/static/images/'));

      if (images.length === 0)
        throw new Error(
          `[${this.name}] chapter ${id} served no page images. The endpoint answered but its ` +
            `<img> list was empty, so there is nothing to read — treat this chapter as unavailable ` +
            `rather than as an empty success.`
        );

      return images.map(
        (img, i): IMangaChapterPage => ({
          page: i + 1,
          img,
          // Carried for parity with the rest of the manga providers, NOT because it is required:
          // both page CDNs were fetched live with no Referer, with `weebcentral.com`, and with a
          // deliberately hostile `evil.example.com`, and all three returned byte-identical images
          // (re-measured 2026-08-14: Oyasumi-Punpun/0001-001.png on official.lowee.us is 526,454 B
          // and One-Piece/0001-001.png on hot.planeptune.us is 345,017 B, each byte-identical
          // across all three referer shapes). There is no hotlink protection, so these images do
          // not strictly need a server-side proxy hop — but note the API layer proxies them anyway,
          // because these CDNs send no Access-Control-Allow-Origin and the host set rotates.
          //
          // One real gotcha for consumers: the URLs end in `.png` and the CDN answers
          // `Content-Type: image/png`, but the bytes are JPEG (`ffd8ffe0`, JFIF) on both hosts.
          // Anything that trusts the extension or the content-type to pick a decoder will be wrong.
          headerForImage: { Referer: `${this.baseUrl}/` },
        })
      );
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };
}

export default Mangasee123;
