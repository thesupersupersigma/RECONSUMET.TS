import {
  IMangaChapter,
  IMangaChapterPage,
  IMangaInfo,
  IMangaResult,
  ISearch,
  MangaParser,
  MediaStatus,
} from '../../models';
import { CheerioAPI, load } from 'cheerio';

interface VyvyMangaSearchResult {
  result: VyvyMangaSearchResultData[];
}

interface VyvyMangaSearchResultData {
  authors: {
    id: number;
    name: string;
    name_url: string;
  }[];
  completed: number; // enum, 0 is completed, 2 is ongoing i think
  created_at: string;
  description: string;
  id: number;
  lastChapter: string;
  latest_chapter_id: number;
  main_manga_id: null;
  name: string;
  name_url: string;
  scored: number;
  status: number; // probably enum aswell
  thumbnail: string;
  title: string; // is alternate titles, seperated by comma
  updated_at: string;
  viewed: number;
  voted: number;
}

class VyvyManga extends MangaParser {
  override readonly name: string = 'Vyvymanga';
  // The service was RENAMED, not shut down: `vyvymanga.net` is dead at the origin (Cloudflare 522 on
  // the apex, on www, on http, on both the HTML and the /api paths). `mangavyvy.net` serves the same
  // application — identical JSON contract, identical markup — so only these host literals moved.
  protected override baseUrl: string = 'https://mangavyvy.net/api';
  protected override logo: string = 'https://mangavyvy.net/web/img/icon.png';
  protected override classPath = 'MANGA.VyvyManga';
  protected baseWebsiteUrl = 'https://mangavyvy.net';

  override search = async (query: string, page: number = 1): Promise<ISearch<IMangaResult>> => {
    if (page < 1) throw new Error('page must be equal to 1 or greater');

    try {
      const formattedQuery = query.trim().toLowerCase().split(' ').join('+');
      const { data }: { data: string } = await this.client.get(
        `${this.baseWebsiteUrl}/search?search_po=0&q=${formattedQuery}&page=${page}`
      );

      const $: CheerioAPI = load(data);
      const dom = $('html');

      const result = dom
        .find('.row.book-list > div > div > a')
        .map((index, ele) => {
          const cover = $(ele).find('div.comic-image');
          // The cover URL is the id carrier: `.../web/cover/<id>/thumbnail.png`. The card used to
          // hang that URL on the wrapper div as `data-background-image`; it now lives on a lazy
          // `<img data-src>` inside it. Read every shape rather than pinning one, because reading
          // the wrong one does not degrade — `.split()` on `undefined` throws and search dies whole.
          const image =
            cover.find('img').attr('data-src') ??
            cover.attr('data-background-image') ??
            cover.find('img').attr('src') ??
            '';
          // Last resort: the bookmark/preview buttons carry the same numeric id as an attribute.
          const id = image.match(/\/cover\/(\d+)\b/)?.[1] ?? $(ele).find('[manga_id]').attr('manga_id') ?? '';

          return {
            id: id,
            title: $(ele).find('div.comic-title').text().trim(),
            image: image,
            lastChapter: $(ele).find('div.comic-image > span').text().trim(),
          };
        })
        .get();

      const pagination = dom.find('ul.pagination');

      if (!pagination.find('li').length) {
        return {
          currentPage: page,
          hasNextPage: false,
          totalPages: page,
          results: result,
        };
      }

      // Laravel's paginator always renders the last page number, so the largest number anywhere in
      // the control is the page count — no positional guessing. (The old code read the
      // second-to-last <li> and pulled its <a>; on the LAST page that <li> is the *active* one, a
      // <span> with no <a>, so totalPages came back NaN and hasNextPage came back true forever.)
      const pageNumbers = pagination
        .find('.page-link')
        .map((index, ele) => parseInt($(ele).text().trim(), 10))
        .get()
        .filter(n => Number.isFinite(n));
      const lastPage = Math.max(page, ...pageNumbers);

      return {
        currentPage: page,
        // A `rel="next"` anchor exists only while there is a next page; the disabled Next control is
        // a <span>. That is exact, so prefer it and fall back to the page-number comparison.
        hasNextPage: pagination.find('a[rel="next"]').length > 0 || page < lastPage,
        totalPages: lastPage,
        results: result,
      };
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  searchApi = async (query: string): Promise<ISearch<IMangaResult>> => {
    try {
      const formattedQuery = query.toLowerCase().split(' ').join('%20');
      const { data }: { data: VyvyMangaSearchResult } = await this.client.request({
        method: 'get',
        url: `${this.baseUrl}/manga/search?search=${formattedQuery}&uid=`,
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          Referer: `${this.baseWebsiteUrl}/`,
        },
      });

      const result = {
        currentPage: 1,
        hasNextPage: false,
        totalPages: 1,
        totalResults: data.result.length,
        results: this.formatSearchResultData(data.result),
      };

      return result;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  override fetchMangaInfo = async (mangaId: string): Promise<IMangaInfo> => {
    try {
      const { data }: { data: string } = await this.client.request({
        method: 'get',
        url: `${this.baseUrl}/manga-detail/${mangaId}?userid=`,
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          Referer: `${this.baseWebsiteUrl}/`,
        },
      });

      const $: CheerioAPI = load(data);
      const dom = $('html');

      const title = dom.find('.img-manga').attr('title') as string;
      const img = dom.find('.img-manga').attr('src');

      // The info block is a variable-length list of <p>s, each labelled by a <span class="pre-title">
      // ("Authors", "Artists", "Status", "Genres"). It is NOT fixed-length: titles that credit an
      // artist carry an extra "Artists" paragraph (manga 55 does, 841 and 97484 do not), which shunts
      // every later row down one slot. Indexing positionally therefore reads Status out of the
      // Artists row and Genres out of the Status row for exactly those titles — and because both
      // lookups then find nothing, the caller gets a silently empty status and empty genres for some
      // titles only, which is the worst possible way to be wrong. Match on the label instead.
      const infoRows = dom.find('div.col-md-7').first().children('p');
      const infoRow = (label: string) =>
        infoRows.filter(
          (index, ele) => $(ele).find('span.pre-title').first().text().trim().toLowerCase() === label
        );

      const authors = infoRow('authors')
        .find('a')
        .map((index, ele) => $(ele).text().trim())
        .get();
      // The value is the one <span> in the row that is neither the label nor the ":" separator
      // (its class encodes the state, e.g. `text-ongoing`, so it cannot be selected by class).
      const statusRow = infoRow('status');
      const statusText =
        statusRow.find('span').not('.pre-title').not('.space').last().text().trim() ||
        statusRow
          .text()
          .replace(/^\s*status\s*:?\s*/i, '')
          .trim();
      const status = (statusText || MediaStatus.UNKNOWN) as MediaStatus;
      const genres = infoRow('genres')
        .find('a')
        .map((index, ele) => $(ele).text().trim())
        .get();
      const description = dom.find('.summary > .content').text().trim();
      const chapters = dom
        .find('.list-group > a')
        .map((index, ele) => {
          const releaseDate = $(ele).find('p').text().trim();
          const title = $(ele).text().replace(releaseDate, '').trim();

          const chapterObj: IMangaChapter = {
            // NOTE: the chapter id is a full absolute URL, not an opaque token — fetchChapterPages
            // GETs it verbatim. It is also not even a mangavyvy.net URL: the API hands back a
            // third-party redirector (`aovheroes.com/rds/...`, itself bouncing on to summonersky.com)
            // carrying an encrypted blob. So a persisted or cached chapter id pins a hostname AND an
            // opaque blob that this project does not control, and neither survives a rename or a key
            // rotation. Anything storing these must re-resolve them from fetchMangaInfo, not migrate
            // them by string substitution.
            id: $(ele).attr('href') as string,
            title: title,
            releaseDate: releaseDate,
          };

          return chapterObj;
        })
        .get()
        .reverse();

      const mangaInfo = {
        id: mangaId,
        title,
        img,
        authors,
        status,
        genres,
        description,
        chapters,
      };

      return mangaInfo;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  override fetchChapterPages = async (chapterId: string): Promise<IMangaChapterPage[]> => {
    try {
      const { data } = await this.client.get(chapterId);

      const $: CheerioAPI = load(data);
      const dom = $('html');

      const images: IMangaChapterPage[] = dom
        .find('.vview.carousel-inner > div > img')
        .map((index, ele) => {
          const src = ($(ele).attr('data-src') as string) ?? '';
          return {
            // Pages are Google/Blogspot-hosted and arrive size-capped with a `=w700` suffix
            // (`.../AJQWtBN...Nmlqp=w700`). Dropping it yields the full-resolution original — the
            // same image at 1200px wide instead of 700. This was previously `.slice(0, -5)`, which
            // is the same 5 characters but silently truncates any URL that lacks the suffix; the
            // pattern is anchored now so a non-Google host passes through untouched.
            img: src.replace(/=[ws]\d+$/, ''),
            page: index + 1,
          };
        })
        .get();

      return images;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  private formatSearchResultData = (searchResultData: VyvyMangaSearchResultData[]): IMangaResult[] => {
    return searchResultData.map(ele => {
      return {
        id: `${ele.id}`,
        title: ele.name,
        altTitles: ele.title
          .split(',')
          .filter(ele => ele.length)
          .map(ele => ele.trim()),
        description: ele.description,
        image: ele.thumbnail,
        status: ele.completed === 1 ? MediaStatus.COMPLETED : MediaStatus.ONGOING,
        score: ele.scored,
        views: ele.viewed,
        votes: ele.voted,
        latestChapterId: ele.latest_chapter_id,
        lastChapter: ele.lastChapter,
      };
    });
  };
}

export default VyvyManga;
