import AnimeNoSub from './animenosub';
import Gogoanime from './gogoanime';
import AnimePahe from './animepahe';
import AnimeUnity from './animeunity';

export default {
  // Fully browser-free (search + episodes + sources over plain HTTP); back-catalog
  // serves megaplay → English subs. Preferred source where it has the title.
  AnimeNoSub,
  Gogoanime,
  AnimePahe,
  // Optional fallback: Italian site. Kept as a working video source —
  // English captions come from the external subtitle layer, not the host.
  AnimeUnity,
};
