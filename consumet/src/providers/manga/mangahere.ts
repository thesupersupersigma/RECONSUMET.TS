import { load } from 'cheerio';

import { MangaParser, ISearch, IMangaInfo, IMangaResult, MediaStatus, IMangaChapterPage } from '../../models';
import { unpackPacker, unpackJsStringConcat } from '../../utils/unpack-packer';

/**
 * Pull one bracketed array literal out of an unpacked MangaHere script by variable name, and return
 * its elements as raw (still-quoted, for string arrays) source text. `null` when the variable is not
 * there at all — callers decide whether that is fatal.
 *
 * The chapter_bar reader's script is `var newImgs=['//a.jpg','//b.jpg'];var newImginfos=[12,13];`,
 * and neither name can be renamed without MangaHere also shipping a new chapter_bar.js, which reads
 * both by those exact names.
 */
const readArrayLiteral = (script: string, name: string): string[] | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(script);
  if (!m) return null;
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
};

/** `'//host/a.jpg'` → `https://host/a.jpg`. Throws — with the offending text — on anything else. */
const imageUrlFromLiteral = (literal: string, where: string): string => {
  const quoted = /^'([^']*)'$/.exec(literal) ?? /^"([^"]*)"$/.exec(literal);
  if (!quoted) throw new Error(`MangaHere: ${where} is not a quoted string literal: ${literal.slice(0, 120)}`);
  const value = quoted[1];
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//.test(value)) return value;
  throw new Error(`MangaHere: ${where} is not an absolute image url: ${value.slice(0, 120)}`);
};

/**
 * MangaHere appends ONE booby-trapped entry to the end of every chapter's image list. Its filename is
 * the real last page's with a single character swapped (`…_image090.jpg` → `…_ah001_image090.jpg`,
 * `/s051.jpg` → `/s05a.jpg`), and `zjcdn.mangahere.org` answers it with HTTP 200 and a genuinely
 * decodable 1000x563 PNG — so neither the status code nor the magic bytes give it away downstream.
 *
 * The site marks it in its own data: the decoy repeats the previous page's image id (`newImginfos`'s
 * last two entries are equal in the chapter_bar reader; `currentimageid` repeats on the final
 * chapterfun.ashx response in the other one). Probed 2026-08-14 across berserk c001/c200/c364,
 * solo_leveling c001/c010, chainsaw_man c001, one_piece v98/c1190, jujutsu_kaisen c001 and
 * oyasumi_punpun c001: every one carried exactly one repeated id, always at the very last index, so
 * keying off the repeat cannot swallow a real page.
 */
const isRepeatedImageId = (id: string, previousId: string): boolean => id !== '' && id === previousId;

class MangaHere extends MangaParser {
  override readonly name = 'MangaHere';
  protected override baseUrl = 'http://www.mangahere.cc';
  protected override logo = 'https://i.pinimg.com/564x/51/08/62/51086247ed16ff8abae2df0bb06448e4.jpg';
  protected override classPath = 'MANGA.MangaHere';

  override fetchMangaInfo = async (mangaId: string): Promise<IMangaInfo> => {
    const mangaInfo: IMangaInfo = {
      id: mangaId,
      title: '',
    };
    try {
      const { data } = await this.client.get(`${this.baseUrl}/manga/${mangaId}`, {
        headers: {
          cookie: 'isAdult=1',
        },
      });

      const $ = load(data);

      mangaInfo.title = $('span.detail-info-right-title-font').text();
      mangaInfo.description = $('div.detail-info-right > p.fullcontent').text();
      mangaInfo.headers = { Referer: this.baseUrl };
      mangaInfo.image = $('div.detail-info-cover > img').attr('src');
      mangaInfo.genres = $('p.detail-info-right-tag-list > a')
        .map((i, el) => $(el).attr('title')?.trim())
        .get();
      switch ($('span.detail-info-right-title-tip').text()) {
        case 'Ongoing':
          mangaInfo.status = MediaStatus.ONGOING;
          break;
        case 'Completed':
          mangaInfo.status = MediaStatus.COMPLETED;
          break;
        default:
          mangaInfo.status = MediaStatus.UNKNOWN;
          break;
      }
      mangaInfo.rating = parseFloat($('span.detail-info-right-title-star > span').last().text());
      mangaInfo.authors = $('p.detail-info-right-say > a')
        .map((i, el) => $(el).attr('title'))
        .get();
      mangaInfo.chapters = $('ul.detail-main-list > li')
        .map((i, el) => ({
          id: $(el).find('a').attr('href')?.split('/manga/')[1].slice(0, -7)!,
          title: $(el).find('a > div > p.title3').text(),
          releasedDate: $(el).find('a > div > p.title2').text().trim(),
        }))
        .get();

      return mangaInfo;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  override fetchChapterPages = async (chapterId: string): Promise<IMangaChapterPage[]> => {
    const chapterPages: IMangaChapterPage[] = [];
    const url = `${this.baseUrl}/manga/${chapterId}/1.html`;

    try {
      const { data } = await this.client.get(url, {
        headers: {
          cookie: 'isAdult=1',
        },
      });

      const $ = load(data);

      const copyrightHandle =
        $('p.detail-block-content').text().match('Dear user') ||
        $('p.detail-block-content').text().match('blocked');
      if (copyrightHandle) {
        throw Error(copyrightHandle.input?.trim());
      }

      const bar = $('script[src*=chapter_bar]').data();
      const html = $.html();
      // WHICH READER YOU GET IS DECIDED PER CHAPTER, NOT PER SERIES. An earlier audit sampled four
      // chapters, found no `chapter_bar` script in any of them, and wrote this branch off as dead
      // code for "a page layout that no longer exists". It is live: berserk/c001, berserk/c200,
      // berserk/c364, solo_leveling/c001 and solo_leveling/c010 all take it, while chainsaw_man/c001,
      // one_piece/v98/c1190, kaguya/c001, jujutsu_kaisen/c001 and oyasumi_punpun/c001 take the other
      // one — same site, same day (probed 2026-08-14). Do not "simplify" this away.
      if (typeof bar !== 'undefined') {
        // mangahere's page is third-party: expand its packed script as data, never execute it.
        const ds = unpackPacker(html, url);

        // This used to be `ds.split("['")[1].split("']")[0].split("','")`, which assumes the first
        // `['` in the unpacked script opens the image array. When that stops being true the `[1]` is
        // `undefined` and the next `.split` throws `Cannot read properties of undefined` — a stack
        // trace that names neither MangaHere nor the chapter. Read the array by name and say so.
        const literals = readArrayLiteral(ds, 'newImgs');
        if (!literals?.length)
          throw new Error(
            `MangaHere: the chapter_bar reader for ${url} shipped no readable newImgs[] — its page ` +
              `shape changed. Unpacked script began: ${ds.slice(0, 200)}`
          );

        const imgs = literals.map((literal, i) => imageUrlFromLiteral(literal, `newImgs[${i}] of ${url}`));

        // drop the trailing soft-404 decoy, which the page flags by repeating the previous image id
        const imageIds = readArrayLiteral(ds, 'newImginfos');
        if (
          imageIds?.length === imgs.length &&
          imgs.length >= 2 &&
          isRepeatedImageId(imageIds[imageIds.length - 1], imageIds[imageIds.length - 2])
        )
          imgs.pop();

        imgs.forEach((img, i) =>
          chapterPages.push({
            page: i,
            img,
            // `url` is the CHAPTER PAGE. This used to read `Referer: url` from inside a
            // `urls.map((url, i) => …)` callback, where `url` was shadowed by the image's own
            // protocol-relative path — so every page went out with `Referer: //zjcdn.mangahere.org/…`.
            // It only ever worked by accident: the CDN's hotlink check is a bare substring test for
            // "mangahere", which the CDN's own hostname happens to satisfy. Any CDN rename would have
            // turned the whole branch into 403s.
            headerForImage: { Referer: url },
          })
        );
      } else {
        let sKey = this.extractKey(html);
        const chapterIdsl = html.indexOf('chapterid');
        const chapterId = html.substring(chapterIdsl + 11, html.indexOf(';', chapterIdsl)).trim();

        const chapterPagesElmnt = $('body > div:nth-child(6) > div > span').children('a');

        const pages = parseInt(chapterPagesElmnt.last().prev().attr('data-page') ?? '0');

        const pageBase = url.substring(0, url.lastIndexOf('/'));

        let resText = '';
        let previousImageId = '';
        for (let i = 1; i <= pages; i++) {
          const pageLink = `${pageBase}/chapterfun.ashx?cid=${chapterId}&page=${i}&key=${sKey}`;

          for (let j = 1; j <= 3; j++) {
            const { data } = await this.client.get(pageLink, {
              headers: {
                Referer: url,
                'X-Requested-With': 'XMLHttpRequest',
                cookie: 'isAdult=1',
              },
            });

            resText = data as string;

            if (resText) break;
            else sKey = '';
          }

          // chapterfun.ashx answers with a packed script; expand it as data.
          const ds = unpackPacker(resText, pageLink);

          // `indexOf(…) + 5` on a missing needle is 4, which silently yields a garbage url instead of
          // an error — strictly worse than throwing, because it surfaces as a broken image much later.
          const pixAt = ds.indexOf('pix=');
          const pvalueAt = ds.indexOf('pvalue=');
          if (pixAt < 0 || pvalueAt < 0)
            throw new Error(
              `MangaHere: chapterfun.ashx answered without pix=/pvalue= for ${pageLink} — its ` +
                `response shape changed. Unpacked script began: ${ds.slice(0, 200)}`
            );

          const baseLinksp = pixAt + 5;
          const baseLinkes = ds.indexOf(';', baseLinksp) - 1;
          const baseLink = ds.substring(baseLinksp, baseLinkes);

          const imageLinksp = pvalueAt + 9;
          const imageLinkes = ds.indexOf('"', imageLinksp);
          const imageLink = ds.substring(imageLinksp, imageLinkes);

          // Same trailing soft-404 decoy as the chapter_bar reader; here the tell is that the final
          // response repeats the previous page's `currentimageid`. Skip rather than break, and take
          // the page number from the list itself, so a repeat anywhere costs one page and not the
          // rest of the chapter.
          const imageId = ds.match(/currentimageid\s*=\s*(\d+)/)?.[1] ?? '';
          if (isRepeatedImageId(imageId, previousImageId)) continue;
          previousImageId = imageId;

          chapterPages.push({
            page: chapterPages.length,
            img: `https:${baseLink}${imageLink}`,
            headerForImage: { Referer: url },
          });
        }
      }
      return chapterPages;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  override search = async (query: string, page: number = 1): Promise<ISearch<IMangaResult>> => {
    const searchRes: ISearch<IMangaResult> = {
      currentPage: page,
      results: [],
    };
    try {
      const { data } = await this.client.get(`${this.baseUrl}/search?title=${query}&page=${page}`);
      const $ = load(data);

      searchRes.hasNextPage = $('div.pager-list-left > a.active').next().text() !== '>';

      searchRes.results = $('div.container > div > div > ul > li')
        .map(
          (i, el): IMangaResult => ({
            id: $(el).find('a').attr('href')?.split('/')[2]!,
            title: $(el).find('p.manga-list-4-item-title > a').text(),
            headerForImage: { Referer: this.baseUrl },
            image: $(el).find('a > img').attr('src'),
            description: $(el).find('p').last().text(),
            status:
              $(el).find('p.manga-list-4-show-tag-list-2 > a').text() === 'Ongoing'
                ? MediaStatus.ONGOING
                : $(el).find('p.manga-list-4-show-tag-list-2 > a').text() === 'Completed'
                ? MediaStatus.COMPLETED
                : MediaStatus.UNKNOWN,
          })
        )
        .get();
      return searchRes;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   *  credit: [tachiyomi-extensions](https://github.com/tachiyomiorg/tachiyomi-extensions/blob/master/src/en/mangahere/src/eu/kanade/tachiyomi/extension/en/mangahere/Mangahere.kt)
   */
  private extractKey = (html: string) => {
    // Two evals used to live here, both on page-controlled text. First the packed key script…
    const skds = unpackPacker(html, `${this.baseUrl} chapter key script`);

    const sksl = skds.indexOf("'");
    const skel = skds.indexOf(';');

    // …then the key itself, which the unpacked script builds as a concatenation of string literals
    // (`''+'e'+'8'+…`). That second eval is NOT a packer, so it does not go through unpackPacker:
    // it gets a parser that accepts quoted literals joined by `+` and throws on anything else,
    // rather than executing whatever expression the page happens to contain.
    const skrs = skds.substring(sksl, skel);

    return unpackJsStringConcat(skrs, `${this.baseUrl} chapter key`);
  };
}

export default MangaHere;
