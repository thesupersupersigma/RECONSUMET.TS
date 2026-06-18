import AniNeko from './anineko';
import AnimeNoSub from './animenosub';
import AnikotoTV from './anikototv';
import ReAnime from './reanime';
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
  // Browser-free zoro/hianime clone on the shared nekostream backend; HD-1 resolves
  // to megaplay (HLS + English soft subs), Kiwi-Stream to vibeplayer. Reuses both
  // existing extractors — no new crack.
  AnikotoTV,
  // Browser-free REST API; gives high-quality .ass English soft subs for free.
  // Video (flixcloud) is WASM/PBKDF2/AES-gated — crack pending (see SOURCES.md).
  ReAnime,
  Gogoanime,
  AnimePahe,
  // Optional fallback: Italian site. Kept as a working video source —
  // English captions come from the external subtitle layer, not the host.
  AnimeUnity,
};
