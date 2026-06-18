import AniNeko from './anineko';
import AnimeNoSub from './animenosub';
import Gogoanime from './gogoanime';
import AnimePahe from './animepahe';
import AnimeUnity from './animeunity';

export default {
  // Fully browser-free + carries SOFT English subtitles for simulcasts (.vtt in
  // the data-video query string) — the only source with extractable simulcast subs.
  AniNeko,
  // Fully browser-free (search + episodes + sources over plain HTTP); back-catalog
  // serves megaplay → English subs. Preferred source where it has the title.
  AnimeNoSub,
  Gogoanime,
  AnimePahe,
  // Optional fallback: Italian site. Kept as a working video source —
  // English captions come from the external subtitle layer, not the host.
  AnimeUnity,
};
