# Contributing to RECONSUMΣT.TS

Thanks for helping out! This project is a trimmed, revived fork of
[`@consumet/extensions`](https://github.com/consumet/extensions). Most contributions are
**new anime sources**, **fixes to existing ones** (sites rotate their CDNs/obfuscation
often), or **docs**.

## Guiding principles

1. **Browser-free first.** Prefer sources you can scrape over plain HTTP. A headless
   browser (cloakbrowser/CDP) is a last resort, used only by the Gogoanime fallback.
2. **Real soft subtitles win.** A source that yields a separate, toggleable English
   `.vtt`/`.ass` is worth more than one with burned-in (hard) subs.
3. **Honesty over green checkmarks.** If something only half-works, say so in
   [`SOURCES.md`](./SOURCES.md). Don't add a source to the aggregator default chain if it
   can't actually play through the proxy.

## Project layout

```
consumet/   the scraping library
  src/providers/anime/   one file per site (extends AnimeParser)
  src/extractors/        one file per video host (extends VideoExtractor)
  src/models/            shared types (ISource, IAnimeEpisode, …)
  src/providers/meta/aggregator.ts   AniList search + cross-provider mapping
api/
  src/server.mjs         the Fastify API + /proxy (Referer injection, TLS-impersonation,
                         playlist rewrite/de-obfuscation)
SOURCES.md               living tracker: every candidate site, status, and recon notes
SETUP.md                 VM deployment guide
```

## Dev setup

```bash
# build the library (re-run after any change under consumet/src)
cd consumet && pnpm install && npx tsc -p tsconfig.json
# ~12 pre-existing strict-type warnings in anilist.ts / rabbit.ts are expected and harmless.
# A new TS2307 (missing import) IS a real error — fix it.

# run the API against the freshly built dist
cd ../api && pnpm install && pnpm start
```

## Adding a new source

A source is usually a **provider** (the site) plus one or more **extractors** (the video
hosts it embeds). Reuse an existing extractor whenever the host matches (megaplay,
vibeplayer, vidmoly, nova, filemoon, …).

1. **Recon first, in `SOURCES.md`.** Add a row: does it have a Cloudflare wall? what stack
   (look for `/assets/immutable/` = SvelteKit, csrf = Laravel, a zoro/hianime clone, …)? is
   search browser-free? what servers/hosts does it list? Test on a known title (we use
   Re:Zero). Find the real **player URL** before assuming you need a browser — for hianime
   clones it's often `/.../ep-N` (a path), not `?ep=N`.
2. **Provider:** create `consumet/src/providers/anime/<site>.ts` extending `AnimeParser`.
   Implement `search`, `fetchAnimeInfo`, `fetchEpisodeSources`, `fetchEpisodeServers`. Match
   the style of an existing one (`anineko.ts`, `anikototv.ts`, and `reanime.ts` are good
   references for HTML-scrape, AJAX, and REST-API sites respectively).
3. **Extractor (if needed):** create `consumet/src/extractors/<host>.ts` extending
   `VideoExtractor`, returning a normalised `ISource`:
   ```ts
   { headers: { Referer }, sources: [{ url, quality, isM3U8 }], subtitles: [{ url, lang }] }
   ```
4. **Register it:**
   - `src/providers/anime/index.ts` and `src/utils/providers-list.ts` (provider)
   - `src/extractors/index.ts` and `src/index.ts` (extractor, both import + export)
   - `src/providers/meta/aggregator.ts` — add to the default `providers` array **only if it
     actually plays end-to-end** (otherwise leave it registered but out of the default chain).
5. **Smoke-test** end-to-end (see below), then **update `SOURCES.md`** to ✅ and add a Claude
   memory note if relevant.

### Gated CDNs (Cloudflare / JA3, obfuscated playlists)

If a stream CDN returns `403 "Attention Required"` to plain `fetch`, it's TLS-fingerprint
gated. Add the host suffix to `TLS_IMPERSONATE_HOSTS` and the `/proxy` will route it through
curl-impersonate (the request must be *fetch*-style: `Sec-Fetch-*: cors/empty`, `Origin`,
`Accept: */*`). If the playlist body comes back as base64 (not `#EXTM3U`), the source is
obfuscating it — have the extractor return a `pk` (see `flixcloud.ts` / `ISource.pk`) and the
proxy will de-obfuscate. See `SOURCES.md` → "reanime.to" for a worked example.

## Testing

There's no formal test suite; use quick end-to-end smoke tests against the built `dist`:

```bash
# provider directly
node -e '
  const P = require("./consumet/dist/providers/anime/<site>").default;
  (async () => {
    const s = await new P().search("re:zero");
    const info = await new P().fetchAnimeInfo(s.results[0].id);
    const src = await new P().fetchEpisodeSources(info.episodes[0].id, undefined, "sub");
    console.log(src.sources.length, "sources;", src.subtitles.map(x => x.lang));
  })().catch(e => console.error(e.message));
'
# or through the API: start it, then curl /search, /info, /episodes, /watch
```

Confirm the m3u8 and subtitle URLs actually fetch (HTTP 200) before claiming a source works.

## Style & commits

- **Match the surrounding code** — naming, JSDoc density, and idioms. Providers/extractors
  carry a class-level doc comment explaining the scrape chain and any gotchas.
- TypeScript, 2-space indent, single quotes (see existing files / `.prettierrc` if present).
- Keep commits focused; write a descriptive message explaining the *why*, not just the *what*.
- Open a PR against `master` with a short summary + how you tested it.

## Scope & legal

Contributions must be for **personal/educational** use. Don't add sources that require
defeating paid-access controls, and don't commit secrets, API keys, or copyrighted media.
This project only indexes and links to streams already public on third-party sites.

## License

By contributing you agree your contributions are licensed under the project's
[GPL-3.0](./LICENSE).
