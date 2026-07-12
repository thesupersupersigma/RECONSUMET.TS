import AniNeko from './anineko';
import AnimeNoSub from './animenosub';
import AnikotoTV from './anikototv';
import AniZone from './anizone';
import AniDB from './anidb';
import UniqueStream from './uniquestream';
import KickAssAnime from './kaa';
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
  // Browser-free, server-rendered on its own CDN; the HLS master sits directly in a
  // <media-player src> attribute (no extractor). Japanese audio + rich soft-subtitle
  // tracks (incl. English .ass). CDN is TLS-fingerprint gated → plays via the proxy.
  AniZone,
  // Self-hosted; genuinely multi-server (one server per audio language, e.g. JP + EN).
  // anidb.app metadata is Cloudflare TLS-gated → fetched via curl-impersonate; the
  // hls.anidb.app video CDN is un-gated (segments are .xls-disguised MPEG-TS).
  AniDB,
  // Self-hosted Crunchyroll re-host on its own *.mediacache.cc CDN; self-documented FastAPI.
  // Genuinely multi-server: one server per audio locale (JP sub + every dub). Signed short-TTL
  // HLS (resolve fresh); segments are .png-disguised MPEG-TS (proxy is extension-agnostic).
  UniqueStream,
  // Self-hosted KickAssAnime: clean JSON API (kaa.lt/api) → krussdomi HLS. Genuinely multi-audio
  // (one master carries Japanese + English audio groups = sub + dub); segments are on rotating
  // .jpg-disguised CDN hosts that gate on Origin (proxy injects it). Only VidStreaming/HLS is used
  // (BirdStream is DASH); non-JP/EN dubs are usually DASH-only and skipped.
  KickAssAnime,
  // Browser-free REST API; gives high-quality .ass English soft subs for free.
  // Video (flixcloud) is WASM/PBKDF2/AES-gated — crack pending (see SOURCES.md).
  ReAnime,
  Gogoanime,
  AnimePahe,
  // Optional fallback: Italian site. Kept as a working video source —
  // English captions come from the external subtitle layer, not the host.
  AnimeUnity,
};
