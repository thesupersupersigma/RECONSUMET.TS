# consumet/ — the scraping library

This is the **library half** of [RECONSUMΣT.TS](../README.md): the anime providers,
video extractors, and the AniList-based aggregator. It's a trimmed fork of
[`@consumet/extensions`](https://github.com/consumet/extensions) focused on a few
reliable, mostly browser-free anime sources with real English subtitles.

> The other half is [`../api/`](../api) — a Fastify service that wraps this library in an
> HTTP API with a streaming proxy. Most users want the API; see the
> [root README](../README.md). Use this library directly if you're embedding the scrapers.

## Build

```bash
pnpm install
npx tsc -p tsconfig.json     # emits CommonJS to ./dist
```

~12 pre-existing strict-type warnings (in `anilist.ts` / `rabbit.ts`) are expected. A new
`TS2307` (missing module) is a real error.

## Use it directly

### The aggregator (AniList search + cross-provider mapping)

```ts
import { AnimeAggregator } from './dist/index.js';

const agg = new AnimeAggregator();

const results  = await agg.search('re:zero');          // AniList results (id, title, …)
const id       = results[0].id;                         // AniList id, e.g. "21355"

const mappings = await agg.getMappings(id);             // which providers have this title
const eps      = await agg.getEpisodes(id, 'AniNeko');  // { provider, providerId, episodes }
const source   = await agg.getSources('AniNeko', eps.episodes[0].id, undefined, 'sub');
// source: { sources: [{ url, quality, isM3U8 }], subtitles: [{ url, lang }], headers, … }
```

The default provider order is
**AniNeko → AnimeNoSub → AnikotoTV → ReAnime → Gogoanime → AnimeUnity**
(pass your own array to the `AnimeAggregator` constructor to override).

### A single provider

```ts
import { ANIME } from './dist/index.js';

const p    = new ANIME.AniNeko();
const res  = await p.search('re:zero');
const info = await p.fetchAnimeInfo(res.results[0].id);
const src  = await p.fetchEpisodeSources(info.episodes[0].id, undefined, 'sub');
```

## What's inside

- **`src/providers/anime/`** — one file per site, each extending `AnimeParser`
  (`search`, `fetchAnimeInfo`, `fetchEpisodeSources`, `fetchEpisodeServers`).
- **`src/extractors/`** — one file per video host, extending `VideoExtractor`, returning a
  normalised `ISource`. Includes some non-trivial reverse-engineering (e.g. `nova.ts`
  AES-128, `flixcloud.ts` WASM+PBKDF2+AES + playlist-XOR key).
- **`src/providers/meta/aggregator.ts`** — AniList GraphQL search + title-similarity mapping.
- **`src/models/`** — shared types (`ISource`, `IAnimeEpisode`, …).

See [`../SOURCES.md`](../SOURCES.md) for per-source status and recon notes, and
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) for how to add a source.

## Streaming caveats

Sources are HLS (`.m3u8`). Many CDNs are `Referer`-locked; some are Cloudflare/JA3-gated;
some obfuscate the playlist body. The extractors produce the right URLs (+ `headers.Referer`,
and a `pk` for obfuscated playlists), but **fetching the stream is the proxy's job** —
that's what `../api/`'s `/proxy` is for. Don't expect a gated CDN's m3u8 to fetch with plain
axios.

## License

[GPL-3.0](./LICENSE) — inherited from `@consumet/extensions`. Keep the upstream copyright for
borrowed code.
