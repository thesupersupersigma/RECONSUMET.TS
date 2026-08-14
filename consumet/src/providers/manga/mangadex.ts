import { encode } from 'ascii-url-encoder';
import { AxiosError, AxiosResponse } from 'axios';

import { IMangaChapterPage, IMangaInfo, IMangaResult, ISearch, MangaParser, MediaStatus } from '../../models';
import { capitalizeFirstLetter, substringBefore, USER_AGENT } from '../../utils';

/**
 * Language keys to try, in order, when collapsing one of MangaDex's
 * `{ [language]: string }` maps down to a single display string.
 *
 * `en` first because it is what a caller of an English-language API wants; then the three
 * romanisations, because a MangaDex entry whose *canonical* title is Japanese/Korean/Chinese
 * almost always carries the romanised form there and that is the name English readers use
 * ("Sousou no Frieren", "Na Honjaman Level-Up"). Anything past that falls through to
 * {@link MangaDex.pickLocalised}'s generic "any `-ro` key, else the first entry" rules.
 */
const LANGUAGE_PREFERENCE = ['en', 'ja-ro', 'ko-ro', 'zh-ro'];

class MangaDex extends MangaParser {
  override readonly name = 'MangaDex';
  protected override baseUrl = 'https://mangadex.org';
  protected override logo = 'https://pbs.twimg.com/profile_images/1391016345714757632/xbt_jW78_400x400.jpg';
  protected override classPath = 'MANGA.MangaDex';

  private readonly apiUrl = 'https://api.mangadex.org';

  /**
   * MANDATORY on every MangaDex host, not a nicety.
   *
   * `api.mangadex.org`, `mangadex.org` and `uploads.mangadex.org` each answer
   * `HTTP 400 {"detail":"You must set an appropriate User-Agent header..."}` to a request that
   * carries no User-Agent (verified live against all three). This provider used to send none and
   * "worked" only because Node's undici fills in `User-Agent: node` by default — an accident that
   * breaks the moment anything sets a different transport (a proxy, a browser build, a fetch shim).
   * Send it explicitly, from the same shared constant as the rest of the tree (see
   * `USER_AGENT` in src/utils/utils.ts and test/user-agent.test.mjs).
   */
  private get headers(): { [key: string]: string } {
    return { 'User-Agent': USER_AGENT, Referer: `${this.baseUrl}/` };
  }

  /**
   * Collapse a MangaDex `{ [language]: value }` map to one string.
   *
   * Order: {@link LANGUAGE_PREFERENCE}, then any romanised key (`*-ro`), then the first non-empty
   * entry. Returns undefined only for an empty/absent map.
   */
  private static pickLocalised = (map: any): string | undefined => {
    if (!map || typeof map !== 'object') return undefined;
    for (const lang of LANGUAGE_PREFERENCE) if (typeof map[lang] === 'string' && map[lang]) return map[lang];
    const romanised = Object.keys(map).find(key => key.endsWith('-ro') && map[key]);
    if (romanised) return map[romanised];
    return Object.values(map).find((value): value is string => typeof value === 'string' && value.length > 0);
  };

  /** `altTitles` is an array of single-key maps; flatten it to one map, first occurrence winning. */
  private static flattenAltTitles = (altTitles: any): { [lang: string]: string } => {
    const flat: { [lang: string]: string } = {};
    if (!Array.isArray(altTitles)) return flat;
    for (const entry of altTitles)
      for (const [lang, value] of Object.entries(entry ?? {}))
        if (!(lang in flat) && typeof value === 'string' && value) flat[lang] = value;
    return flat;
  };

  /**
   * THE 89% BUG. This used to be `attributes.title.en`.
   *
   * MangaDex's `title` is a language map and most entries simply have no `en` key — Berserk's is
   * literally `{"ja-ro":"Berserk"}`, Solo Leveling's is `{"ko-ro":"Na Honjaman Level-Up"}`. Measured
   * live against the 200 most-followed manga: 183 (91.5%) carry no `en` title, so `title` came back
   * `undefined` for nearly the whole catalogue. Resolve through the preference order instead, and
   * only if the title map is unusable fall through to `altTitles`.
   */
  private static resolveTitle = (attributes: any): string =>
    MangaDex.pickLocalised(attributes?.title) ??
    MangaDex.pickLocalised(MangaDex.flattenAltTitles(attributes?.altTitles)) ??
    '';

  /**
   * The officially published English name, which for a romanised entry lives in `altTitles`
   * ("Na Honjaman Level-Up" → "Solo Leveling", "Sono Bisque Doll wa Koi o Suru" → "My Dress-Up
   * Darling"). Kept separate from `title` so `title` stays MangaDex's own canonical name;
   * a UI that wants the English one now has it without re-scanning `altTitles`.
   */
  private static englishTitle = (attributes: any): string | undefined => {
    const fromTitle = attributes?.title?.en;
    if (typeof fromTitle === 'string' && fromTitle) return fromTitle;
    const fromAlt = MangaDex.flattenAltTitles(attributes?.altTitles).en;
    return fromAlt || undefined;
  };

  override fetchMangaInfo = async (mangaId: string): Promise<IMangaInfo> => {
    try {
      const { data } = await this.client.get(`${this.apiUrl}/manga/${mangaId}`, { headers: this.headers });
      const mangaInfo: IMangaInfo = {
        id: data.data.id,
        title: MangaDex.resolveTitle(data.data.attributes),
        englishTitle: MangaDex.englishTitle(data.data.attributes),
        altTitles: data.data.attributes.altTitles,
        description: data.data.attributes.description,
        genres: data.data.attributes.tags
          .filter((tag: any) => tag.attributes.group === 'genre')
          .map((tag: any) => tag.attributes.name.en),
        themes: data.data.attributes.tags
          .filter((tag: any) => tag.attributes.group === 'theme')
          .map((tag: any) => tag.attributes.name.en),
        status: capitalizeFirstLetter(data.data.attributes.status) as MediaStatus,
        releaseDate: data.data.attributes.year,
        chapters: [],
      };

      const allChapters = await this.fetchAllChapters(mangaId, 0);
      for (const chapter of allChapters) {
        // A MangaDex chapter record can be a *stub* pointing at MangaPlus/Webnovel/etc: MangaDex
        // indexes it but stores no images, so fetchChapterPages can never serve it. That shows up
        // here as a non-null `externalUrl` and/or `pages: 0`. Surface it on the listing so a caller
        // can filter unreadable chapters out before ever asking for pages.
        const externalUrl: string | null = chapter.attributes.externalUrl ?? null;
        const pageCount = Number(chapter.attributes.pages ?? 0);
        mangaInfo.chapters?.push({
          id: chapter.id,
          title: chapter.attributes.title ? chapter.attributes.title : chapter.attributes.chapter,
          chapterNumber: chapter.attributes.chapter,
          volumeNumber: chapter.attributes.volume,
          pages: pageCount,
          externalUrl,
          /** false => {@link fetchChapterPages} will throw for this id; read it at `externalUrl`. */
          readable: externalUrl === null && pageCount > 0,
        });
      }

      const findCoverArt = data.data.relationships.find((rel: any) => rel.type === 'cover_art');
      const coverArt = await this.fetchCoverImage(findCoverArt?.id);
      mangaInfo.image = `${this.baseUrl}/covers/${mangaInfo.id}/${coverArt}`;
      // the cover host 400s without a User-Agent too, so tell the caller what to send
      mangaInfo.headers = this.headers;

      return mangaInfo;
    } catch (err) {
      if ((err as AxiosError).code == 'ERR_BAD_REQUEST')
        throw new Error(`[${this.name}] Bad request. Make sure you have entered a valid query.`);

      throw new Error((err as Error).message);
    }
  };

  /**
   * Build the error for a chapter MangaDex indexes but cannot serve images for.
   *
   * WHY AN ERROR AND NOT AN EMPTY ARRAY. Everywhere else in this tree a provider signals "this
   * media is not available from me" by throwing a descriptive Error — `media not available for
   * ${locale}` in uniquestream.ts, `master playlist not available upstream` in
   * utils.verifyMasterPlaylist — never by returning an empty collection, because an aggregator's
   * per-provider fallthrough keys on the throw. Returning `[]` made MangaDex look like a
   * *successful* source with a genuinely zero-page chapter, which is why all 24 English chapters of
   * the site's most-followed manga silently rendered as a blank reader. The cheap, non-throwing
   * signal lives on the chapter listing instead (`readable` / `externalUrl` from fetchMangaInfo),
   * so a caller that checks it never reaches this path.
   *
   * Only ever called on the failure path, so the extra `/chapter/{id}` lookup costs nothing in the
   * normal case; if it fails we still report the original diagnosis.
   */
  private unreadableChapterError = async (chapterId: string, symptom: string): Promise<Error> => {
    let externalUrl: string | undefined;
    try {
      const { data } = await this.client.get(`${this.apiUrl}/chapter/${chapterId}`, { headers: this.headers });
      externalUrl = data?.data?.attributes?.externalUrl ?? undefined;
    } catch {
      // a nicety — never let it replace the real diagnosis
    }

    return new Error(
      `[${this.name}] chapter ${chapterId} is not readable on MangaDex (${symptom}). ` +
        (externalUrl
          ? `It is an external stub; the pages live at ${externalUrl} and MangaDex stores no images for it. `
          : 'MangaDex stores no images for it. ') +
        'fetchMangaInfo marks these chapters `readable: false` and carries their `externalUrl`.'
    );
  };

  /**
   * @currently only supports english
   *
   * Throws {@link unreadableChapterError} rather than returning `[]` for the two ways a chapter can
   * have no images on MangaDex (both reproduced live):
   *   - `/at-home/server/{id}` 404s — One Piece's English chapters are MangaPlus stubs;
   *   - `/at-home/server/{id}` answers **HTTP 200** with `{"chapter":{"hash":"","data":[],"dataSaver":[]}}`
   *     — every English chapter of Solo Leveling, which is a Webnovel stub.
   *
   * NOTE: the returned `img` URLs are short-lived. `baseUrl` is a MangaDex@Home node picked per
   * request and the token embedded in the path expires in roughly 15 minutes, so these must not be
   * cached long-term — re-call this method instead of persisting the URLs.
   */
  override fetchChapterPages = async (chapterId: string): Promise<IMangaChapterPage[]> => {
    let res: AxiosResponse<any, any>;
    try {
      res = await this.client.get(`${this.apiUrl}/at-home/server/${chapterId}`, { headers: this.headers });
    } catch (err) {
      if ((err as AxiosError).response?.status === 404)
        throw await this.unreadableChapterError(chapterId, 'no MangaDex@Home node has it — HTTP 404');
      throw new Error((err as Error).message);
    }

    const hash: string = res.data?.chapter?.hash ?? '';
    const ids: string[] = res.data?.chapter?.data ?? [];
    // HTTP 200 with an empty page list is MangaDex saying "indexed, but I hold no images".
    if (!hash || ids.length === 0)
      throw await this.unreadableChapterError(chapterId, 'MangaDex@Home returned an empty page list on HTTP 200');

    return ids.map(id => ({
      img: `${res.data.baseUrl}/data/${hash}/${id}`,
      page: parseInt(substringBefore(id, '-').replace(/[^0-9.]/g, '')),
      // Measured: the @Home node itself serves these without a User-Agent, unlike
      // uploads.mangadex.org (covers), which 400s. Hand the caller the headers anyway — one
      // consistent recipe for every MangaDex image, and it costs the node nothing.
      headers: this.headers,
    }));
  };

  /**
   * @param query search query
   * @param page page number (default: 1)
   * @param limit limit of results to return (default: 20) (max: 100) (min: 1)
   */
  override search = async (
    query: string,
    page: number = 1,
    limit: number = 20
  ): Promise<ISearch<IMangaResult>> => {
    if (page <= 0) throw new Error('Page number must be greater than 0');
    if (limit > 100) throw new Error('Limit must be less than or equal to 100');
    if (limit * (page - 1) >= 10000) throw new Error('not enough results');

    try {
      const res = await this.client.get(
        `${this.apiUrl}/manga?limit=${limit}&title=${encode(query)}&limit=${limit}&offset=${
          limit * (page - 1)
        }&order[relevance]=desc`,
        { headers: this.headers }
      );

      if (res.data.result == 'ok') {
        const results: ISearch<IMangaResult> = {
          currentPage: page,
          results: [],
        };

        for (const manga of res.data.data) {
          const findCoverArt = manga.relationships.find((item: any) => item.type === 'cover_art');
          const coverArtId = findCoverArt ? findCoverArt.id : null;
          const coverArt = await this.fetchCoverImage(
            coverArtId === null || coverArtId === void 0 ? void 0 : coverArtId
          );

          results.results.push({
            id: manga.id,
            title: MangaDex.resolveTitle(manga.attributes),
            englishTitle: MangaDex.englishTitle(manga.attributes),
            altTitles: manga.attributes.altTitles,
            description: MangaDex.pickLocalised(manga.attributes.description),
            status: manga.attributes.status,
            releaseDate: manga.attributes.year,
            contentRating: manga.attributes.contentRating,
            lastVolume: manga.attributes.lastVolume,
            lastChapter: manga.attributes.lastChapter,
            image: `${this.baseUrl}/covers/${manga.id}/${coverArt}`,
            headers: this.headers,
          });
        }

        return results;
      } else {
        throw new Error(res.data.message);
      }
    } catch (err) {
      if ((err as AxiosError).code == 'ERR_BAD_REQUEST') {
        throw new Error('Bad request. Make sure you have entered a valid query.');
      }

      throw new Error((err as Error).message);
    }
  };
  fetchRandom = async (): Promise<ISearch<IMangaResult>> => {
    try {
      const res = await this.client.get(`${this.apiUrl}/manga/random`, { headers: this.headers });

      if (res.data.result == 'ok') {
        const results: ISearch<IMangaResult> = {
          currentPage: 1,
          results: [],
        };
        const findCoverArt = res.data.data.relationships.find((item: any) => item.type === 'cover_art');
        const coverArtId = findCoverArt ? findCoverArt.id : null;
        const coverArt = await this.fetchCoverImage(
          coverArtId === null || coverArtId === void 0 ? void 0 : coverArtId
        );

        results.results.push({
          id: res.data.data.id,
          title: MangaDex.resolveTitle(res.data.data.attributes),
          englishTitle: MangaDex.englishTitle(res.data.data.attributes),
          altTitles: res.data.data.attributes.altTitles,
          description: MangaDex.pickLocalised(res.data.data.attributes.description),
          status: res.data.data.attributes.status,
          releaseDate: res.data.data.attributes.year,
          contentRating: res.data.data.attributes.contentRating,
          lastVolume: res.data.data.attributes.lastVolume,
          lastChapter: res.data.data.attributes.lastChapter,
          image: `${this.baseUrl}/covers/${res.data.data.id}/${coverArt}`,
          headers: this.headers,
        });

        return results;
      } else {
        throw new Error(res.data.message);
      }
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };
  fetchRecentlyAdded = async (page: number = 1, limit: number = 20): Promise<ISearch<IMangaResult>> => {
    if (page <= 0) throw new Error('Page number must be greater than 0');
    if (limit > 100) throw new Error('Limit must be less than or equal to 100');
    if (limit * (page - 1) >= 10000) throw new Error('not enough results');

    try {
      const res = await this.client.get(
        `${
          this.apiUrl
        }/manga?includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&order[createdAt]=desc&hasAvailableChapters=true&limit=${limit}&offset=${
          limit * (page - 1)
        }`,
        { headers: this.headers }
      );

      if (res.data.result == 'ok') {
        const results: ISearch<IMangaResult> = {
          currentPage: page,
          results: [],
        };

        for (const manga of res.data.data) {
          const findCoverArt = manga.relationships.find((item: any) => item.type === 'cover_art');
          const coverArtId = findCoverArt ? findCoverArt.id : null;
          const coverArt = await this.fetchCoverImage(
            coverArtId === null || coverArtId === void 0 ? void 0 : coverArtId
          );
          results.results.push({
            id: manga.id,
            title: MangaDex.resolveTitle(manga.attributes),
            englishTitle: MangaDex.englishTitle(manga.attributes),
            altTitles: manga.attributes.altTitles,
            description: MangaDex.pickLocalised(manga.attributes.description),
            status: manga.attributes.status,
            releaseDate: manga.attributes.year,
            contentRating: manga.attributes.contentRating,
            lastVolume: manga.attributes.lastVolume,
            lastChapter: manga.attributes.lastChapter,
            image: `${this.baseUrl}/covers/${manga.id}/${coverArt}`,
            headers: this.headers,
          });
        }

        return results;
      } else {
        throw new Error(res.data.message);
      }
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };
  fetchLatestUpdates = async (page: number = 1, limit: number = 20): Promise<ISearch<IMangaResult>> => {
    if (page <= 0) throw new Error('Page number must be greater than 0');
    if (limit > 100) throw new Error('Limit must be less than or equal to 100');
    if (limit * (page - 1) >= 10000) throw new Error('not enough results');

    try {
      const res = await this.client.get(
        `${this.apiUrl}/manga?order[latestUploadedChapter]=desc&limit=${limit}&offset=${limit * (page - 1)}`,
        { headers: this.headers }
      );

      if (res.data.result == 'ok') {
        const results: ISearch<IMangaResult> = {
          currentPage: page,
          results: [],
        };

        for (const manga of res.data.data) {
          const findCoverArt = manga.relationships.find((item: any) => item.type === 'cover_art');
          const coverArtId = findCoverArt ? findCoverArt.id : null;
          const coverArt = await this.fetchCoverImage(
            coverArtId === null || coverArtId === void 0 ? void 0 : coverArtId
          );

          results.results.push({
            id: manga.id,
            title: MangaDex.resolveTitle(manga.attributes),
            englishTitle: MangaDex.englishTitle(manga.attributes),
            altTitles: manga.attributes.altTitles,
            description: MangaDex.pickLocalised(manga.attributes.description),
            status: manga.attributes.status,
            releaseDate: manga.attributes.year,
            contentRating: manga.attributes.contentRating,
            lastVolume: manga.attributes.lastVolume,
            lastChapter: manga.attributes.lastChapter,
            image: `${this.baseUrl}/covers/${manga.id}/${coverArt}`,
            headers: this.headers,
          });
        }

        return results;
      } else {
        throw new Error(res.data.message);
      }
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };
  fetchPopular = async (page: number = 1, limit: number = 20): Promise<ISearch<IMangaResult>> => {
    if (page <= 0) throw new Error('Page number must be greater than 0');
    if (limit > 100) throw new Error('Limit must be less than or equal to 100');
    if (limit * (page - 1) >= 10000) throw new Error('not enough results');

    try {
      const res = await this.client.get(
        `${
          this.apiUrl
        }/manga?includes[]=cover_art&includes[]=artist&includes[]=author&order[followedCount]=desc&contentRating[]=safe&contentRating[]=suggestive&hasAvailableChapters=true&limit=${limit}&offset=${
          limit * (page - 1)
        }`,
        { headers: this.headers }
      );

      if (res.data.result == 'ok') {
        const results: ISearch<IMangaResult> = {
          currentPage: page,
          results: [],
        };

        for (const manga of res.data.data) {
          const findCoverArt = manga.relationships.find((item: any) => item.type === 'cover_art');
          const coverArtId = findCoverArt ? findCoverArt.id : null;
          const coverArt = await this.fetchCoverImage(
            coverArtId === null || coverArtId === void 0 ? void 0 : coverArtId
          );

          results.results.push({
            id: manga.id,
            title: MangaDex.resolveTitle(manga.attributes),
            englishTitle: MangaDex.englishTitle(manga.attributes),
            altTitles: manga.attributes.altTitles,
            description: MangaDex.pickLocalised(manga.attributes.description),
            status: manga.attributes.status,
            releaseDate: manga.attributes.year,
            contentRating: manga.attributes.contentRating,
            lastVolume: manga.attributes.lastVolume,
            lastChapter: manga.attributes.lastChapter,
            image: `${this.baseUrl}/covers/${manga.id}/${coverArt}`,
            headers: this.headers,
          });
        }

        return results;
      } else {
        throw new Error(res.data.message);
      }
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };
  private fetchAllChapters = async (
    mangaId: string,
    offset: number,
    res?: AxiosResponse<any, any>
  ): Promise<any[]> => {
    if (res?.data?.offset + 96 >= res?.data?.total) {
      return [];
    }

    const response = await this.client.get(
      `${this.apiUrl}/manga/${mangaId}/feed?offset=${offset}&limit=96&order[volume]=desc&order[chapter]=desc&translatedLanguage[]=en`,
      { headers: this.headers }
    );

    return [...response.data.data, ...(await this.fetchAllChapters(mangaId, offset + 96, response))];
  };

  private fetchCoverImage = async (coverId: string): Promise<string> => {
    const { data } = await this.client.get(`${this.apiUrl}/cover/${coverId}`, { headers: this.headers });

    const fileName = data.data.attributes.fileName;

    return fileName;
  };
}

// (async () => {
//   const md = new MangaDex();
//   const search = await md.search('solo leveling');
//   const manga = await md.fetchMangaInfo(search.results[0].id);
//   const chapterPages = await md.fetchChapterPages(manga.chapters![0].id);
//   console.log(chapterPages);
// })();

export default MangaDex;
