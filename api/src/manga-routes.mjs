// Manga routes for the anime-api, as a Fastify plugin.
//
// WHY A SEPARATE MODULE: server.mjs is already 576 lines and ~65% of it is the video /proxy
// machinery (HLS rewriting, XOR de-obfuscation, UniqueStream key derivation, curl-impersonate).
// None of that is manga. Keeping manga here means the two surfaces can be reasoned about (and
// broken) independently. The convention it borrows from server.mjs is deliberate and total: the
// same `apiGuard(tier)` / `rateLimit(tier)` preHandler stack, the same `{ error: '...' }` body on
// every failure, the same numeric-id param validation, the same 400/502 split.
//
// STATUS: every handler answers 501. The route SHAPE is real (params are validated, the SSRF guard
// on /manga/image is LIVE, not stubbed) but no provider is wired, because provider triage is a
// separate workstream and the surviving set is not yet known. Nothing here imports a manga provider
// or the consumet dist bundle on purpose — a dead provider must not be able to break this module.
//
// HOW MANGA DIFFERS FROM THE ANIME ROUTES (deliberate divergences, each justified):
//   1. Path prefix. Anime routes are unprefixed (/search, /info/:anilistId). `/search` is taken and
//      already means "anime", so manga lives under /manga/*. This is the one convention break, and
//      it is forced.
//   2. :anilistId is a DIFFERENT ID SPACE. AniList numbers anime and manga separately — One Piece
//      is anime id 21 and manga id 30013. A client must not reuse an anime id here. Same numeric
//      validator, different namespace.
//   3. /watch splits on sub|dub. Manga's equivalent axis is TRANSLATED LANGUAGE, so /manga/read
//      takes `lang` (BCP-47-ish, default 'en'). There is no pair to fetch concurrently, so no
//      Promise.allSettled and no "502 only if both are null" rule — one language, one result.
//   4. Chapter matching cannot be verified by count the way episodes are. See MATCH CONFIDENCE.
//
// MATCH CONFIDENCE (the honest part):
//   AnimeAggregator.verifyMatch() rejects a wrong-season match using (a) a leaked AniList id,
//   (b) a season/part ordinal contradiction, (c) an episode-count backstop. Manga has no seasons
//   and no reliable chapter count — AniList returns `chapters: null` for any RELEASING series
//   (verified against One Piece, AniList manga id 30013), and even a finished count disagrees with
//   providers that split chapters, number decimals (100.5), or carry an "Official Colored" re-release
//   as a separate series. So (c) has NO manga equivalent and must not be faked.
//   What replaces it is id-bridging, strongest first:
//     'exact-id'   — MangaDex `attributes.links.al` equals the requested AniList id, or MAL-Sync
//                    (api.malsync.moe/mal/manga/<idMal>) named this provider id outright.
//     'metadata'   — title similarity plus start-year and countryOfOrigin/format agreement.
//     'unverified' — title similarity alone. Served, but LABELLED, never silently.
//   Every response that carries a provider match must carry `matchConfidence` so a client can
//   decide, and (when nothing matched) a `reason` string — same contract as the anime
//   getEpisodes() result, which returns `{ provider: null, episodes: [], reason }`.
//
// @typedef {Object} MangaMapping
// @property {string} provider         provider name, e.g. 'MangaDex'
// @property {string} id               provider-specific manga id/slug
// @property {string} title            the provider's title for that match
// @property {number} score            title similarity 0..1, pre-heuristic (mirrors IProviderMapping)
// @property {'exact-id'|'metadata'|'unverified'} matchConfidence
// @property {string} [via]            what produced an 'exact-id' match: 'mangadex-links.al' | 'malsync'
//
// @typedef {Object} MangaChapter
// @property {string} id               provider chapter id, passed back to /manga/read
// @property {string} title
// @property {string} [chapterNumber]  string, NOT number — providers emit '100.5', 'Extra', 'Oneshot'
// @property {string} [volumeNumber]
// @property {number} [pages]
// @property {string} [lang]           translated language of this chapter
// @property {string} [releaseDate]
//
// @typedef {Object} MangaPage
// @property {number} page             1-based
// @property {string} img              same-origin /manga/image URL (Referer already baked in)
// @property {string} rawImg           the upstream URL, unproxied — mirrors /watch's `rawUrl`

import { assertUrlSafe, SsrfError } from './ssrf-guard.mjs';

/** Body every stub returns. Exported so tests assert on the constant, not a copied string. */
export const NOT_IMPLEMENTED =
  'manga provider layer not wired yet — route shape is final, provider triage is pending';

/** Local copy of server.mjs's validator. Duplicated (4 tokens) rather than editing server.mjs to
 *  export it; if a third module ever needs it, lift both to a shared validators module. */
const isNumericId = v => /^\d+$/.test(String(v ?? ''));

/** Language tags we accept on /manga/read. Deliberately strict — this string is destined for a
 *  provider query param, so it is allowlisted by SHAPE, not merely trusted. */
const isLangTag = v => /^[a-z]{2}(-[a-z]{2,4})?$/i.test(String(v ?? ''));

const notImplemented = (reply, route, next) =>
  reply.code(501).send({ error: NOT_IMPLEMENTED, route, ...(next ? { next } : {}) });

/**
 * Fastify plugin. Guards are INJECTED rather than imported so this module never reaches back into
 * server.mjs (which has top-level `await app.listen()` and would boot a server on import) and so the
 * test suite can mount the real routes on a throwaway app.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{ apiGuard?: (tier: string) => any[], rateLimit?: (tier: string) => any }} opts
 */
export default async function mangaRoutes(app, opts = {}) {
  // Defaults are no-ops so the plugin is mountable bare in tests. In server.mjs the real
  // apiGuard/rateLimit are passed in, so manga inherits the API-key gate and the per-IP tiers
  // with zero divergence.
  const apiGuard = opts.apiGuard ?? (() => []);
  const rateLimit = opts.rateLimit ?? (() => async () => {});

  // ---- search ------------------------------------------------------------------------------
  // Mirrors GET /search exactly: same 'default' tier, same q/page validation, same 400 bodies.
  // Returns { results: MangaResult[] } once wired.
  app.get('/manga/search', { preHandler: apiGuard('default') }, async (req, reply) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return reply.code(400).send({ error: "missing or empty 'q' query param" });
    const page = Number(req.query.page) || 1;
    if (page < 1) return reply.code(400).send({ error: "'page' must be >= 1" });
    return notImplemented(reply, 'GET /manga/search', 'AniList Media(type: MANGA) search');
  });

  // ---- info --------------------------------------------------------------------------------
  // Mirrors GET /info/:anilistId — 'scrape' tier, numeric param, { id, mappings } envelope.
  // Divergence: each mapping carries `matchConfidence` (see the header). The anime route has no
  // such field because episode-count verification happens later, in /episodes; for manga there is
  // no later verification step, so confidence has to travel with the mapping itself.
  app.get('/manga/info/:anilistId', { preHandler: apiGuard('scrape') }, async (req, reply) => {
    if (!isNumericId(req.params.anilistId))
      return reply.code(400).send({ error: 'anilistId must be numeric' });
    return notImplemented(
      reply,
      'GET /manga/info/:anilistId',
      'AniList manga meta + per-provider mappings (MangaDex links.al / MAL-Sync id bridge)'
    );
  });

  // ---- chapters ----------------------------------------------------------------------------
  // Mirrors GET /episodes/:anilistId — 'scrape' tier, optional ?provider= preference, and the same
  // "walk providers, return the first that verifies, else empty WITH a reason" contract.
  // Divergence: ?lang= (translated language) has no anime analogue; a provider's chapter list is
  // per-language, so it is a first-class filter rather than a post-hoc choice.
  app.get('/manga/chapters/:anilistId', { preHandler: apiGuard('scrape') }, async (req, reply) => {
    if (!isNumericId(req.params.anilistId))
      return reply.code(400).send({ error: 'anilistId must be numeric' });
    if (req.query.lang != null && !isLangTag(req.query.lang))
      return reply.code(400).send({ error: "'lang' must be a language tag like 'en' or 'pt-br'" });
    return notImplemented(
      reply,
      'GET /manga/chapters/:anilistId',
      '{ provider, providerId, matchConfidence, chapters[], reason? }'
    );
  });

  // ---- read (pages) ------------------------------------------------------------------------
  // Mirrors GET /watch: 'watch' tier (image reads are the expensive, extractor-equivalent call),
  // provider + id in the query string rather than the path, 400 on missing params.
  //
  // SSRF: /watch guards a URL-shaped episodeId because several anime providers fetch it directly.
  // Manga providers have the same pattern (a chapterId that starts with 'http' is treated as a URL),
  // so chapterId gets the SAME guard, wired live below — not deferred to implementation time.
  app.get('/manga/read', { preHandler: apiGuard('watch') }, async (req, reply) => {
    const { provider, chapterId } = req.query;
    if (!provider || !chapterId)
      return reply.code(400).send({ error: "missing 'provider' and/or 'chapterId' query params" });
    if (req.query.lang != null && !isLangTag(req.query.lang))
      return reply.code(400).send({ error: "'lang' must be a language tag like 'en' or 'pt-br'" });
    if (typeof chapterId === 'string' && chapterId.startsWith('http')) {
      try {
        await assertUrlSafe(chapterId);
      } catch (e) {
        if (e instanceof SsrfError) return reply.code(400).send({ error: `'chapterId' rejected: ${e.message}` });
        return reply.code(400).send({ error: "invalid 'chapterId' query param" });
      }
    }
    return notImplemented(reply, 'GET /manga/read', '{ pages: MangaPage[], headers? }');
  });

  // ---- image proxy -------------------------------------------------------------------------
  // A SEPARATE, SIMPLER SIBLING OF /proxy — not a reuse, and not an extension. Rationale:
  //   * Referer injection IS required, empirically and per-host: mangapill's CDN
  //     (cdn.readdetectiveconan.com) answers 403 with no Referer and 200 with
  //     `Referer: https://mangapill.com/`. MangaDex's own CDN (*.mangadex.network) needs no Referer
  //     at all — but it swaps in a small placeholder JPEG when an `Origin` header is present, which
  //     is exactly what a browser fetch()/XHR sends. A server-side hop that injects Referer and
  //     sends NO Origin normalises both cases; nothing on the client can.
  //   * Everything else /proxy does is dead weight here: no playlist rewriting, no XOR
  //     de-obfuscation (`pk`), no AES key.bin derivation (`km`), no HLS default-audio rewrite
  //     (`aud`), no Origin injection (`org`) — for images `org` is actively harmful, see above.
  //   * A different traffic shape needs a different bucket. /proxy's tier is 600/min sized for one
  //     video's segment storm; a manga reader prefetching chapters is 20-60 requests per chapter and
  //     would contend with video playback in the SAME per-IP bucket, letting a reader 429 their own
  //     stream. Hence tier 'image'.
  //   * Narrower is safer. /proxy will stream back ANY content-type from any public URL. This route
  //     is contractually image-only; the implementation must reject a non-image content-type, which
  //     removes it as a general-purpose open relay.
  //
  // SSRF — WIRED NOW, NOT LATER. This is the one thing that is not stubbed, because the guard being
  // absent is a previously-exploited bug class in this repo:
  //   1. `assertUrlSafe(url)` runs BEFORE anything else and BEFORE any socket is opened (below).
  //      SsrfError maps to 400 with the same `'url' rejected: ...` phrasing /proxy uses.
  //   2. When the fetch is implemented it MUST go through `followSafeRedirects(...)`, exactly as
  //      proxiedUpstream() does, so every redirect hop is re-validated. A raw fetch() with
  //      redirect:'follow' reopens the vector and is the single thing not to do here.
  //   3. `ref` is header-injected, never fetched, so it needs no SSRF check — but it IS newline-
  //      stripped below, since it lands in a request header.
  // No API-key gate, matching /proxy: these URLs are embedded in <img src> and cannot carry headers.
  app.get('/manga/image', { preHandler: rateLimit('image') }, async (req, reply) => {
    const target = req.query.url;
    if (!target) return reply.code(400).send({ error: "missing 'url' query param" });
    try {
      await assertUrlSafe(target);
    } catch (e) {
      if (e instanceof SsrfError) return reply.code(400).send({ error: `'url' rejected: ${e.message}` });
      return reply.code(400).send({ error: "invalid 'url' query param" });
    }
    const ref = typeof req.query.ref === 'string' ? req.query.ref.replace(/[\r\n]/g, '') : undefined;
    if (ref && !/^https?:\/\//i.test(ref))
      return reply.code(400).send({ error: "'ref' must be an http(s) url" });
    return notImplemented(
      reply,
      'GET /manga/image',
      'followSafeRedirects + Referer injection + image/* content-type allowlist'
    );
  });
}
