import { ANIME, MANGA, BOOKS, COMICS, LIGHT_NOVELS, MOVIES, META, NEWS } from '../providers';

/**
 * List of providers
 *
 * add new providers here (order does not matter)
 */
export const PROVIDERS_LIST = {
  ANIME: [
    new ANIME.AniNeko(),
    new ANIME.AnimeNoSub(),
    new ANIME.AnikotoTV(),
    new ANIME.AniZone(),
    new ANIME.AniDB(),
    new ANIME.UniqueStream(),
    new ANIME.KickAssAnime(),
    new ANIME.Senshi(),
    new ANIME.ReAnime(),
    new ANIME.Gogoanime(),
    new ANIME.AnimePahe(),
    new ANIME.Mkissa(),
    new ANIME.AnimeUnity(),
  ],
  MANGA: [
    new MANGA.MangaDex(),
    new MANGA.MangaHere(),
    new MANGA.MangaKakalot(),
    new MANGA.Mangapark(),
    new MANGA.MangaPill(),
    new MANGA.Mangasee123(), // reports itself as 'WeebCentral' — the class name is historical
    new MANGA.ComicK(),
    new MANGA.FlameScans(), // reports itself as 'FlameComics'
    // Rewritten against api.asurascans.com and verified end to end this wave. It was exported from
    // ../providers/manga but never listed here, which made a working provider undiscoverable
    // through the public PROVIDERS_LIST while unrepaired ones stayed visible.
    new MANGA.AsuraScans(),
  ],
  BOOKS: [new BOOKS.Libgen()],
  COMICS: [new COMICS.GetComics()],
  LIGHT_NOVELS: [new LIGHT_NOVELS.ReadLightNovels()],
  MOVIES: [
    new MOVIES.DramaCool(),
    new MOVIES.FlixHQ(),
    new MOVIES.Fmovies(),
    new MOVIES.Goku(),
    new MOVIES.KissAsian(),
    new MOVIES.MovieHdWatch(),
    new MOVIES.ViewAsian(),
  ],
  NEWS: [new NEWS.ANN()],
  META: [new META.Anilist(), new META.TMDB(), new META.Myanimelist()],
  OTHERS: [],
};
