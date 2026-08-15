// Manga routes for the anime-api, as a Fastify plugin.
//
// WHY A SEPARATE MODULE: server.mjs is already 576 lines and ~65% of it is the video /proxy
// machinery (HLS rewriting, XOR de-obfuscation, UniqueStream key derivation, curl-impersonate).
// None of that is manga. Keeping manga here means the two surfaces can be reasoned about (and
// broken) independently. The convention it borrows from server.mjs is deliberate and total: the
// same `apiGuard(tier)` / `rateLimit(tier)` preHandler stack, the same `{ error: '...' }` body on
// every failure, the same numeric-id param validation, the same 400/502 split.
//
// STATUS: all five manga routes are live. /manga/search, /manga/info/:anilistId,
// /manga/chapters/:anilistId and /manga/read are WIRED to MangaAggregator; /manga/image serves
// bytes and is the one route with no aggregator call in it. The SSRF guards on BOTH URL-taking
// inputs (/manga/image?url= and /manga/read?chapterId=http...) are live, as they have been since
// the scaffold.
//
// ENV THIS MODULE READS (all at module load):
//   MANGA_TIMEOUT_MS          wall clock for search/info/chapters (default 30000)
//   MANGA_READ_TIMEOUT_MS     wall clock for /manga/read (default 60000)
//   MANGA_IMAGE_TIMEOUT_MS    wall clock for one /manga/image upstream GET (default 15000)
//   MANGA_IMAGE_MAX_BYTES     response-size ceiling for /manga/image (default 20 MiB)
//   MANGA_DIRECT_IMAGE_HOSTS  comma-list of image-CDN host suffixes to link DIRECTLY, skipping
//                             the proxy entirely (default EMPTY — proxy everything; see
//                             "DOES EVERY IMAGE NEED THE PROXY?" below)
//   PUBLIC_URL                origin used for /manga/image links (shared with server.mjs)
//   RATE_LIMIT_IMAGE          per-IP/min for /manga/image (read by server.mjs, default 300)
//
// THE AGGREGATOR IS INJECTED, NOT IMPORTED. This module still imports nothing from
// ../../consumet/dist — server.mjs owns the single dist import and hands the instance in. Two
// reasons, both practical: a dead manga provider must not be able to break this module's import
// graph, and the offline test suite can drive the REAL routes with a fake aggregator over real
// HTTP instead of stubbing at the HTTP layer and testing nothing.
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
//   5. AN UNKNOWN ?provider= IS 400, NOT 502. /watch answers 502 there, but only because its
//      Promise.allSettled wrapper cannot tell "you typed the provider name wrong" apart from "both
//      extractors failed" — it sees two rejections either way. Here there is one call and the
//      registry is knowable up front, so a typo is reported as what it is (a client error) with
//      the valid names listed. Same on /manga/chapters, where the alternative is worse than a 502:
//      the aggregator SILENTLY IGNORES an unknown preferred provider and falls back to the rest,
//      so `?provider=MangaDx` would quietly return WeebCentral's chapters and look like success.
//   6. 504, a status the anime surface never returns. See TIMEOUTS.
//   7. Cache-Control is PER PROVIDER, read off the aggregator's answer. See CACHING.
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
//   THE ROUTES PASS THESE THROUGH VERBATIM. Nothing here re-derives, re-labels or drops a
//   confidence, a `via`, a `reason` or a chapter's `unavailable` flag: a route that quietly
//   upgraded a label would defeat the entire point of the tier system, and a route that dropped
//   `unavailable` would leave a reader to discover a locked chapter by getting an error from it.
//
// CONFIDENCE IS NOT SERVABILITY — what /manga/chapters can now hand back, and why:
//   A provider can be certainly the right series and still serve zero pages for it. Solo Leveling
//   (AniList manga 105398) is the case: MangaDex asserts that AniList id on its own record, so the
//   mapping is 'exact-id' and CORRECT, but all 24 English chapters are webnovel.com `externalUrl`
//   stubs. Listing chapters and reading the first one therefore used to end in a 502 from
//   /manga/read on a top-10 title.
//   The aggregator now treats readability as an ADMISSIBILITY FILTER rather than a ranking signal
//   (the full argument, including the four alternatives rejected, is in `getChapters`'s doc in
//   consumet/src/providers/meta/manga-aggregator.ts). Two consequences visible on this route, both
//   ADDITIVE — no field changed shape, no status code moved:
//     1. The `provider` that answers /manga/chapters may not be the highest-confidence one, when
//        that one can serve nothing. `matchConfidence` still describes THE PROVIDER THAT ANSWERED,
//        so it may legitimately read 'metadata' or 'unverified' where it used to read 'exact-id'.
//        Clients that show a confidence badge were already reading it per response; nothing here
//        rewrites it.
//     2. `reason` is no longer "present iff provider is null". It is ALSO present on the one
//        degraded success — a chapter list served even though every chapter in it is unavailable,
//        which happens only when no provider anywhere had a readable list. That answer is still
//        200 and still carries the full list with per-chapter `unavailable` markers, because it is
//        strictly more useful than `{ provider: null, chapters: [] }`. A client that needs to
//        branch should test `chapters.every(c => c.unavailable)`, not parse the prose.
//   NOTHING IN THIS FILE IMPLEMENTS ANY OF THAT. It is stated here because this file is the
//   published contract for the envelope, and the envelope's `reason` invariant moved.
//
// TIMEOUTS — why this surface needs a wall clock and /watch does not:
//   MangaHere's `fetchChapterPages` issues one upstream request PER PAGE, SERIALLY. A 166-page
//   chapter is ~167 requests and ~15s on the happy path, and its aggregator budget allows 600
//   before the circuit breaker trips — which at its 10 req/s gate is a minute of held connection.
//   The aggregator bounds each INNER request (axios `HTTP_TIMEOUT_MS`, default 20s) but nothing
//   bounds the SUM, so without a cap here a single reader can pin a connection open indefinitely.
//   Every aggregator call below therefore races a wall-clock deadline and answers 504 (not 502:
//   "we gave up waiting" is a different fact from "upstream failed", and only one of them is worth
//   a client retrying). The orphaned work is not cancellable — axios has no signal wired here — but
//   it cannot run forever either, because each of its own requests is still individually bounded.
//
// CACHING (/manga/read): the aggregator returns a PER-PROVIDER `cache` policy and the route turns
//   that, and only that, into Cache-Control. A single global value would be wrong for at least one
//   provider by construction: MangaDex hands out a per-request at-home host that dies in ~15
//   minutes, while scanlation CDNs serve content-addressed paths that are stable for a year. The
//   response body carries the policy too, `note` included, so a caching client can see the reason
//   rather than reverse-engineer the number.
//
// DOES EVERY IMAGE NEED THE PROXY? (the B5 question, answered on measurement, 2026-08-14, all six
// registered providers, real page URLs pulled through the real parsers, four request shapes each:
// no Referer / correct Referer / hostile `https://evil.example.com/` Referer / `Origin` present.)
//
//   HARD-REQUIRES THE HOP — 403 + a ~4.5 KB Cloudflare "you have been blocked" HTML page without
//   the right Referer, 200 + real bytes with it:
//     MangaPill   cdn.readdetectiveconan.com   403/4582B → 200/464,095B image/jpeg
//     MangaHere   zjcdn.mangahere.org          403/4573B → 200/324,529B image/jpeg
//   A browser sends `Referer: https://<our site>/` on a cross-origin <img>, which is exactly the
//   "hostile" case above. So these two CANNOT be linked directly, by anyone, ever.
//
//   HARD-REQUIRES THE HOP FOR A REASON A REFERER PROBE DOES NOT SHOW — MangaDex. Its CDN ignores
//   Referer completely (identical 767,192-byte PNG with none, the right one and a hostile one) but
//   answers `Vary: Origin, Referer`, and an `Origin` header changes the ANSWER:
//     Origin alone                → HTTP 404, ZERO bytes
//     Origin + correct Referer    → HTTP 200, a 59,480-byte JPEG PLACEHOLDER (not the 767 KB page)
//                                   plus `Access-Control-Allow-Origin: <that origin>`
//   `Origin` is not optional for a browser: any CORS-mode load (fetch/XHR preloading, a service
//   worker, canvas) sends it and no client-side setting can suppress it. Only a server hop that
//   sends Referer and NO Origin gets the real bytes in every case. This route therefore never
//   sends an Origin header — that is a correctness requirement, not hygiene, and it is pinned by
//   a test.
//
//   NO HOTLINK PROTECTION AT ALL — byte-identical 200s (same sha256) across all four shapes:
//     AsuraScans   cdn.asurascans.com      237,210 B image/webp, RIFF/WEBP magic
//     FlameComics  cdn.flamecomics.xyz   1,023,199 B image/jpeg
//     WeebCentral  hot.planeptune.us       847,836 B declared image/png — BYTES ARE JPEG (ffd8ffe1)
//
// DECISION: a SEPARATE, SIMPLER SIBLING ROUTE (Phase 2's recommendation, CONFIRMED), and by
// default it proxies EVERY page — including the three CDNs that provably do not need it. The
// per-provider `needsProxy` shape the evidence suggests is implemented, but as CONFIGURATION
// (`MANGA_DIRECT_IMAGE_HOSTS`, default empty), not as the default policy. Four reasons, three of
// them measured here rather than assumed:
//   1. NONE of the three open CDNs sends `Access-Control-Allow-Origin`, even when asked with an
//      Origin. A direct URL is therefore usable from <img src> and from NOTHING ELSE — no
//      fetch()-based preloading, no canvas, no service-worker cache. This route sends ACAO '*'.
//      There is no manga client in the site repo yet (checked), so nothing pins the loading mode,
//      and going direct by default would silently constrain a client that has not been written.
//   2. THE OPEN HOST SET ROTATES, so any allowlist is stale by construction. WeebCentral serves
//      from a DIFFERENT CDN host per series, and the set drifts: measured 2026-08-14, Oyasumi
//      Punpun is on official.lowee.us (which the registry named correctly) while One Piece and
//      Solo Leveling are on hot.planeptune.us — where the registry, and this provider's own
//      source comment, both still said scans-hot.planeptune.us. Half the named hosts had gone
//      stale without anything failing, which is precisely the failure mode an exact-host
//      allowlist has. (Both stale references are now corrected; suffix matching on
//      `planeptune.us` is what makes the switch survive the next rotation.)
//   3. ALL THREE SIT BEHIND CLOUDFLARE (`server: cloudflare`, cf-cache-status HIT). The rule that
//      makes MangaPill's CDN 403 is one WAF toggle on the same platform, and when it flips the
//      failure is INVISIBLE server-side: broken images in a browser, nothing in our logs.
//   4. Proxying is wrong in the cheap direction (bandwidth) and direct is wrong in the expensive
//      one (a silently broken reader). The saving is real — FlameComics is ~1 MB per page and the
//      brief measured 3.5 MB on a long strip — so the switch exists, is suffix-matched exactly
//      like server.mjs's TLS_IMPERSONATE_HOSTS, and needs no code change to flip. It is off until
//      someone owns the measurement.
//
// WHY NOT REUSE OR EXTEND /proxy: everything /proxy does beyond "fetch with a Referer" is dead
// weight or actively wrong here — HLS playlist rewriting, XOR de-obfuscation (`pk`), UniqueStream
// key.bin derivation (`km`), the default-audio rewrite (`aud`), curl-impersonate, and `org`, which
// injects the one header that breaks MangaDex. It also has no content-type restriction (an open
// relay for ANY body), no size ceiling, and a 600/min bucket sized for one video's segment storm
// that a chapter prefetch would share and evict. Extending it would mean adding image-only
// branches to the most security-sensitive handler in the repo. See the route comment below.
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
// @property {string} [releaseDate]   FORMAT IS PROVIDER-DEPENDENT, not ISO. MangaDex and
//                                    FlameComics emit an ISO-8601 instant ('2018-01-31T07:07:06.000Z');
//                                    MangaHere emits the site's own text ('Nov 05,2018'), as do
//                                    MangaPark and VyvyManga. Since the servability policy landed,
//                                    MangaHere answers Solo Leveling and One Piece by default, so
//                                    one caller sees both shapes. Render verbatim, or parse
//                                    defensively — `new Date(releaseDate)` is not guaranteed.
// @property {{reason: string, detail?: string}} [unavailable]  listed but unreadable (external/locked/premium)
//
// @typedef {Object} MangaPage
// @property {number} page             1-based
// @property {string} img              same-origin /manga/image URL (Referer already baked in)
// @property {string} rawImg           the upstream URL, unproxied — mirrors /watch's `rawUrl`

import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';
import { assertUrlSafe, followSafeRedirects, SsrfError } from './ssrf-guard.mjs';
// `isNumericId`, `isSingle` and the outbound-header helpers are SHARED with server.mjs rather than
// copied into both files. They used to be duplicated here behind a "change one, change the other"
// comment, which is precisely how /proxy's `ref` ended up without the scheme check this file's
// /manga/image already had. See ./validators.mjs.
import { isNumericId, isSingle, headerSafe, isRefererUrl } from './validators.mjs';

/** Local copy of server.mjs's browser UA, for the same reason and with the same value. Every CDN
 *  behind these routes is Cloudflare-fronted and at least one provider already 403s a bot UA. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Language tags we accept on /manga/read. Deliberately strict — this string is destined for a
 *  provider query param, so it is allowlisted by SHAPE, not merely trusted. */
const isLangTag = v => /^[a-z]{2}(-[a-z]{2,4})?$/i.test(String(v ?? ''));

// NOTE on `isSingle` (imported above): not every param on these routes needs it. /manga/search's
// `q`/`page` and /manga/chapters' `lang`/`provider` already fail CLOSED on an array, because each
// is coerced with `String(v)` before a shape test that an array cannot satisfy: a repeated param
// always yields >= 2 elements, so the join always contains a comma, and neither `isLangTag`'s
// anchored regex nor `canonicalProvider`'s exact name match can accept one. Measured — see the
// arity sweep in test/server-repeated-params.test.mjs for the server.mjs half of the same audit.

// ---- wall-clock deadlines (see TIMEOUTS in the header) ---------------------------------------

/** Search / info / chapters. Generous because /manga/info fans out across every provider and the
 *  slowest of them sets the pace: MangaDex's search fires one serial cover-art request PER RESULT
 *  and its chapter feed pages at 96 chapters per request, both behind a 4 req/s gate. */
export const MANGA_TIMEOUT_MS = Number(process.env.MANGA_TIMEOUT_MS) || 30000;
/** /manga/read only. Double, and for exactly one reason: MangaHere fetches pages one HTTP request
 *  at a time (see the header). A legitimate long chapter really does take ~15s there. */
export const MANGA_READ_TIMEOUT_MS = Number(process.env.MANGA_READ_TIMEOUT_MS) || 60000;

/** Distinguishable so the handler can answer 504 rather than folding a deadline into the 502 bucket. */
export class MangaTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MangaTimeoutError';
  }
}

/**
 * Race `work` against a wall clock. The timer is unref'd so a pending deadline cannot by itself
 * keep the process alive, and it is cleared on settle so a fast call leaves nothing behind.
 * Promise.race subscribes to `work`, so a late rejection is still handled and never surfaces as an
 * unhandledRejection.
 */
const withTimeout = (work, ms, label) => {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new MangaTimeoutError(`${label} exceeded ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
};

// ---- the image-proxy seam --------------------------------------------------------------------

/**
 * The public origin to build /manga/image links against, for the duration of one request.
 *
 * WHY AsyncLocalStorage AND NOT A PARAMETER. `MangaAggregator`'s `imageProxy` seam is a
 * CONSTRUCTOR option — one function, installed once, called once per page deep inside `getPages`.
 * The origin it must produce is PER REQUEST (`req.headers.host`, unless PUBLIC_URL pins it). The
 * alternatives are worse: a module-level "current base" is a data race between two concurrent
 * readers on different hosts, and re-mapping the pages in the handler afterwards LOSES DATA —
 * `getPages` picks a per-page Referer (MangaHere emits `headerForImage` per page) and bakes it into
 * `img`, but the returned page object never says which one it used. Only the seam sees it.
 */
const imageBase = new AsyncLocalStorage();

/**
 * Image-CDN host suffixes to link DIRECTLY, skipping this deployment entirely. The `needsProxy`
 * switch the B5 evidence supports — see "DOES EVERY IMAGE NEED THE PROXY?" in the header for why
 * it ships EMPTY (proxy everything) rather than pre-loaded with the three CDNs measured to have no
 * hotlink protection.
 *
 * Suffix-matched exactly like server.mjs's TLS_IMPERSONATE_HOSTS, so `planeptune.us` covers
 * `hot.planeptune.us` and `scans-hot.planeptune.us` — which matters, because that provider's CDN
 * host rotates and an exact-host list goes stale silently.
 */
export const DIRECT_IMAGE_HOSTS = (process.env.MANGA_DIRECT_IMAGE_HOSTS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

/** True when `rawImg`'s host is on the direct list. Unparseable → false, i.e. fail toward the
 *  proxy: an odd URL is exactly the one that should not be handed straight to a browser. */
export const isDirectImageHost = rawImg => {
  if (!DIRECT_IMAGE_HOSTS.length) return false;
  let host;
  try {
    host = new URL(rawImg).hostname.toLowerCase();
  } catch {
    return false;
  }
  return DIRECT_IMAGE_HOSTS.some(d => host === d || host.endsWith(`.${d}`));
};

/**
 * The `imageProxy` seam implementation. server.mjs passes THIS into `new MangaAggregator({...})`,
 * which is the whole of the wiring — the aggregator has no business knowing its own origin, and
 * this module has no business knowing the aggregator's page loop.
 *
 * The Referer is baked into the link because an <img src> cannot carry a header: mangapill's CDN
 * answers 403 without one. Falls back to a ROOT-RELATIVE url when called outside a request and with
 * no PUBLIC_URL set (a direct library caller) — still a correct same-origin link, and honest about
 * the fact that nothing told us the origin.
 *
 * A host on DIRECT_IMAGE_HOSTS is returned UNCHANGED, so `img === rawImg` and the browser fetches
 * the CDN itself. Off by default, so this is a no-op on the shipped `pages[].img` contract.
 */
export const mangaImageProxy = (rawImg, ref) =>
  isDirectImageHost(rawImg)
    ? rawImg
    : `${imageBase.getStore() ?? process.env.PUBLIC_URL ?? ''}/manga/image?url=${encodeURIComponent(rawImg)}` +
      (ref ? `&ref=${encodeURIComponent(ref)}` : '');

/**
 * Build the aggregator this plugin expects. The CLASS is passed in rather than imported, so
 * server.mjs keeps the single `../../consumet/dist/index.js` import and this module keeps its
 * independence from the provider bundle — but the seam installation lives HERE, next to the seam
 * itself and next to the route its links point at, instead of being a detail server.mjs has to
 * remember. One line there, and one place to look when a page image 404s.
 *
 * @param {new (opts?: object) => any} MangaAggregator the class exported from the consumet bundle
 * @param {object} [options] extra aggregator options (providers, metadata, bridges, classifier)
 */
export const createMangaAggregator = (MangaAggregator, options = {}) =>
  new MangaAggregator({ imageProxy: mangaImageProxy, ...options });

/** Same derivation server.mjs's proxyBase() uses, so /manga/image and /proxy links agree. */
const publicBase = req => process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`;

// ---- shared handler helpers ------------------------------------------------------------------

/**
 * One place that decides 502 vs 504, so no handler can accidentally report a deadline as an
 * upstream fault. Mirrors server.mjs's `${what} upstream failed: ${e.message}` phrasing exactly.
 */
const upstreamFailed = (reply, what, e) =>
  e instanceof MangaTimeoutError
    ? reply.code(504).send({ error: `${what} timed out: ${e.message}` })
    : reply.code(502).send({ error: `${what} upstream failed: ${e.message}` });

/** Registered provider names, defensively — a caller may inject anything as the aggregator. */
const providerNamesOf = agg => (Array.isArray(agg?.providerNames) ? agg.providerNames : []);

/** Case-insensitive lookup returning the provider's CANONICAL name, or undefined. Matches the
 *  aggregator's own `entryFor`, so "mangadex" and "MangaDex" behave identically here and there. */
const canonicalProvider = (agg, name) =>
  providerNamesOf(agg).find(n => n.toLowerCase() === String(name).toLowerCase());

const unknownProvider = (reply, agg, name) =>
  reply.code(400).send({
    error: `unknown provider '${name}'`,
    providers: providerNamesOf(agg),
  });

/**
 * Cache-Control for /manga/read, derived from the provider's OWN policy (see CACHING in the
 * header). `no-store` when a provider states no policy at all: an unknown expiry is not a licence
 * to cache, and a wrong TTL here serves dead image URLs to a reader with no way to recover.
 */
// ---- /manga/image: content sniffing and the size ceiling -------------------------------------

/** One upstream image GET. Much shorter than PROXY_TIMEOUT_MS (30s, sized for a video manifest):
 *  this is a single object from a CDN edge, and a reader has 20-60 of them in flight per chapter. */
export const MANGA_IMAGE_TIMEOUT_MS = Number(process.env.MANGA_IMAGE_TIMEOUT_MS) || 15000;

/**
 * Response-size ceiling. Manga pages are genuinely large — long-strip webtoon pages measured at
 * 3.5 MB (800x11886), and 1,023,199 B on FlameComics live today — so this cannot be tight. 20 MiB
 * is ~6x the largest page ever observed, which leaves room for a pathological strip while still
 * bounding what an unauthenticated caller can pull through this box in one request. Without it,
 * `/manga/image?url=<any 4 GB file on the public internet>` is a free bandwidth amplifier.
 */
export const MANGA_IMAGE_MAX_BYTES = Number(process.env.MANGA_IMAGE_MAX_BYTES) || 20 * 1024 * 1024;

/** Enough for every signature below (WebP and AVIF both need 12). */
const SNIFF_BYTES = 32;

/**
 * The content-type check that does NOT trust the content-type.
 *
 * Two live traps make the declared header useless as ground truth:
 *   * WeebCentral serves a URL ending `.png` with `Content-Type: image/png` and JPEG bytes
 *     (ffd8ffe1). Confirmed again today at 847,836 B. Anything picking a decoder, a cache key or a
 *     transform off the extension or the header is wrong on that provider.
 *   * A Cloudflare block page is HTML. It usually arrives with a 403 and `text/html` (both caught
 *     earlier), but nothing stops an upstream labelling one `image/jpeg`.
 * So the bytes decide, and the type we send downstream is the SNIFFED one.
 *
 * The allowlist is binary raster formats only. SVG is deliberately absent and would fail anyway
 * (no magic number): an SVG served from OUR origin and opened directly is a document that can run
 * script, which is how an open image proxy turns into stored XSS. Rejecting by magic number closes
 * that without a special case. JPEG XL is also absent — its bare-codestream signature is two bytes
 * (ff 0a), too weak to allowlist on, and no manga CDN serves it.
 *
 * @returns {string|undefined} the real MIME type, or undefined if these are not image bytes
 */
export const sniffImageMime = buf => {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const at = (off, ...bytes) => bytes.every((v, i) => b[off + i] === v);
  const ascii = (off, s) => b.length >= off + s.length && b.subarray(off, off + s.length).toString('latin1') === s;
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return 'image/avif';
  if (ascii(0, 'BM')) return 'image/bmp';
  return undefined;
};

/**
 * Read from `reader` until at least `n` bytes are buffered or the stream ends. Only the HEAD is
 * ever held in memory — the rest is streamed straight through (see the ceiling note above; a
 * 3.5 MB page buffered per concurrent request is a memory profile this box should not have).
 */
const readHead = async (reader, n) => {
  const parts = [];
  let len = 0;
  let done = false;
  while (len < n) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    parts.push(Buffer.from(r.value));
    len += r.value.length;
  }
  return { head: Buffer.concat(parts, len), done };
};

/**
 * The already-sniffed head, then the rest of the body, counting bytes. Past the ceiling it THROWS
 * rather than yielding: the response headers are long gone by then, so the only honest signal left
 * is a destroyed stream (a truncated image) — which beats quietly relaying an unbounded body.
 */
const imageBodyStream = (head, reader, done, max) =>
  Readable.from(
    (async function* () {
      let sent = 0;
      let chunk = head;
      let headWasTheWholeBody = done;
      for (;;) {
        sent += chunk.length;
        if (sent > max) throw new Error(`image body exceeded ${max} bytes`);
        yield chunk;
        if (headWasTheWholeBody) return;
        const r = await reader.read();
        if (r.done) return;
        chunk = Buffer.from(r.value);
      }
    })()
  );

export const cacheControlFor = cache => {
  const ttl = Number(cache?.ttlSeconds);
  if (!Number.isFinite(ttl) || ttl < 0) return 'no-store';
  return `public, max-age=${Math.floor(ttl)}${cache?.immutable === true ? ', immutable' : ''}`;
};

/**
 * Fastify plugin. Guards and the aggregator are INJECTED rather than imported so this module never
 * reaches back into server.mjs (which has top-level `await app.listen()` and would boot a server on
 * import), never imports the consumet bundle, and so the test suite can mount the real routes on a
 * throwaway app with a fake aggregator.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{
 *   aggregator: import('../../consumet/dist/providers/meta/manga-aggregator.js').default,
 *   apiGuard?: (tier: string) => any[],
 *   rateLimit?: (tier: string) => any,
 *   imageFetch?: typeof fetch   // /manga/image's socket layer; test-only, see the route comment
 * }} opts
 */
export default async function mangaRoutes(app, opts = {}) {
  // Defaults are no-ops so the plugin is mountable with only an aggregator. In server.mjs the real
  // apiGuard/rateLimit are passed in, so manga inherits the API-key gate and the per-IP tiers
  // with zero divergence.
  const apiGuard = opts.apiGuard ?? (() => []);
  const rateLimit = opts.rateLimit ?? (() => async () => {});
  // LOUD, AT REGISTRATION. The alternative — degrading to 501 — would turn a wiring mistake into a
  // response body that looks deliberate, which is exactly the failure this module spent a whole
  // wave being explicit about. Fastify surfaces a throwing plugin as a failed boot.
  const agg = opts.aggregator;
  if (!agg)
    throw new Error(
      'mangaRoutes requires an { aggregator } option (a MangaAggregator, or a fake exposing ' +
        'search/getMappings/getChapters/getPages/providerNames)'
    );

  // ---- search ------------------------------------------------------------------------------
  // Mirrors GET /search exactly: same 'default' tier, same q/page validation, same 400 bodies,
  // same { results } envelope, same 502 phrasing. AniList only — no provider is touched here, so
  // this is the one manga route whose cost does not depend on which scrapers are alive.
  app.get('/manga/search', { preHandler: apiGuard('default') }, async (req, reply) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return reply.code(400).send({ error: "missing or empty 'q' query param" });
    const page = Number(req.query.page) || 1;
    if (page < 1) return reply.code(400).send({ error: "'page' must be >= 1" });
    try {
      return { results: await withTimeout(agg.search(q, page), MANGA_TIMEOUT_MS, 'manga search') };
    } catch (e) {
      return upstreamFailed(reply, 'manga search', e);
    }
  });

  // ---- info --------------------------------------------------------------------------------
  // Mirrors GET /info/:anilistId — 'scrape' tier, numeric param, { id, mappings } envelope.
  // Divergence: each mapping carries `matchConfidence` (see the header). The anime route has no
  // such field because episode-count verification happens later, in /episodes; for manga there is
  // no later verification step, so confidence has to travel with the mapping itself.
  //
  // `mappings` is the aggregator's array UNTOUCHED, which also means it stays in the aggregator's
  // order: confidence first, then title score. A client taking mappings[0] gets the best-EVIDENCED
  // match rather than the best-spelled one, and re-sorting here would undo that.
  app.get('/manga/info/:anilistId', { preHandler: apiGuard('scrape') }, async (req, reply) => {
    if (!isNumericId(req.params.anilistId))
      return reply.code(400).send({ error: 'anilistId must be numeric (AniList MANGA id, not the anime id)' });
    try {
      const mappings = await withTimeout(
        agg.getMappings(req.params.anilistId),
        MANGA_TIMEOUT_MS,
        'manga mapping'
      );
      return { id: req.params.anilistId, mappings };
    } catch (e) {
      return upstreamFailed(reply, 'manga mapping', e);
    }
  });

  // ---- chapters ----------------------------------------------------------------------------
  // Mirrors GET /episodes/:anilistId — 'scrape' tier, optional ?provider= preference, and the same
  // "walk providers, return the first that verifies, else empty WITH a reason" contract. The
  // aggregator's envelope is returned VERBATIM: { provider, providerId, matchConfidence, via?,
  // lang, chapters[], reason? }.
  //
  // 200, NOT 404, WHEN NOTHING MATCHED. `{ provider: null, chapters: [], reason }` is a successful
  // answer to a well-formed question — the same choice /episodes makes — and the `reason` is the
  // payload. A 404 would throw the reason away and make "no provider serves pt-br" look like "no
  // such manga".
  //
  // AND 200 WITH A PROVIDER *AND* A `reason` for the one degraded case: a list every chapter of
  // which is `unavailable`, returned only when no provider had a readable one. See "CONFIDENCE IS
  // NOT SERVABILITY" in the header — this route does not produce it, it only refuses to drop it.
  //
  // Divergence: ?lang= (translated language) has no anime analogue; a provider's chapter list is
  // per-language, so it is a first-class filter rather than a post-hoc choice.
  app.get('/manga/chapters/:anilistId', { preHandler: apiGuard('scrape') }, async (req, reply) => {
    if (!isNumericId(req.params.anilistId))
      return reply.code(400).send({ error: 'anilistId must be numeric (AniList MANGA id, not the anime id)' });
    if (req.query.lang != null && !isLangTag(req.query.lang))
      return reply.code(400).send({ error: "'lang' must be a language tag like 'en' or 'pt-br'" });
    // See divergence 5: the aggregator silently ignores a preferred provider it does not know, so
    // an unchecked typo returns another provider's chapters and reads as success.
    let provider;
    if (req.query.provider != null && String(req.query.provider) !== '') {
      provider = canonicalProvider(agg, req.query.provider);
      if (!provider) return unknownProvider(reply, agg, req.query.provider);
    }
    try {
      return await withTimeout(
        agg.getChapters(req.params.anilistId, {
          ...(provider ? { provider } : {}),
          ...(req.query.lang ? { lang: String(req.query.lang) } : {}),
        }),
        MANGA_TIMEOUT_MS,
        'manga chapters'
      );
    } catch (e) {
      return upstreamFailed(reply, 'manga chapters', e);
    }
  });

  // ---- read (pages) ------------------------------------------------------------------------
  // Mirrors GET /watch: 'watch' tier (image reads are the expensive, extractor-equivalent call),
  // provider + id in the query string rather than the path, 400 on missing params.
  //
  // SSRF: /watch guards a URL-shaped episodeId because several anime providers fetch it directly.
  // Manga providers have the same pattern (a chapterId that starts with 'http' is treated as a URL),
  // so chapterId gets the SAME guard, wired live below — and it runs BEFORE the provider-name check
  // so that no ordering change can ever make a rejected URL reach a socket.
  //
  // Returns the aggregator's envelope plus nothing: { provider, chapterId, pages[], headers?,
  // cache }. `pages[].img` is already a /manga/image link with this request's origin and the
  // per-page Referer baked in — see the imageProxy seam above.
  app.get('/manga/read', { preHandler: apiGuard('watch') }, async (req, reply) => {
    const { provider, chapterId } = req.query;
    if (!provider || !chapterId)
      return reply.code(400).send({ error: "missing 'provider' and/or 'chapterId' query params" });
    // A REPEATED PARAM IS A GUARD BYPASS, NOT A CURIOSITY. Fastify's querystring parser turns
    // ?chapterId=a&chapterId=b into an ARRAY, and the SSRF check below is (correctly) written as a
    // string test — so an array would sail past it and then be stringified on the way to the
    // provider as 'http://169.254.169.254/,x', which still starts with 'http'. Single-valued or 400.
    if (typeof provider !== 'string' || typeof chapterId !== 'string')
      return reply.code(400).send({ error: "'provider' and 'chapterId' must each be given exactly once" });
    if (req.query.lang != null && !isLangTag(req.query.lang))
      return reply.code(400).send({ error: "'lang' must be a language tag like 'en' or 'pt-br'" });
    if (chapterId.startsWith('http')) {
      try {
        await assertUrlSafe(chapterId);
      } catch (e) {
        if (e instanceof SsrfError) return reply.code(400).send({ error: `'chapterId' rejected: ${e.message}` });
        return reply.code(400).send({ error: "invalid 'chapterId' query param" });
      }
    }
    const name = canonicalProvider(agg, provider);
    if (!name) return unknownProvider(reply, agg, provider);

    let result;
    try {
      result = await imageBase.run(publicBase(req), () =>
        withTimeout(
          agg.getPages(name, chapterId, req.query.lang ? { lang: String(req.query.lang) } : {}),
          MANGA_READ_TIMEOUT_MS,
          'manga read'
        )
      );
    } catch (e) {
      return upstreamFailed(reply, 'manga read', e);
    }
    // The provider's own policy, never a constant. See CACHING in the header.
    reply.header('Cache-Control', cacheControlFor(result?.cache));
    return result;
  });

  // ---- image proxy -------------------------------------------------------------------------
  // A SEPARATE, SIMPLER SIBLING OF /proxy — not a reuse, and not an extension. Phase 2 recommended
  // this and the measurements in the header CONFIRM it; the four-way decision and the per-host
  // numbers behind it live there, not here. In one line: three of the six registered providers
  // cannot be linked directly by anyone (MangaPill and MangaHere 403 a browser's Referer; MangaDex
  // answers a CORS-mode load with a placeholder), and the other three send no ACAO, so a direct URL
  // works in <img src> and nowhere else.
  //
  // What this route does, and nothing more:
  //   * injects Referer, and NEVER an Origin (the MangaDex trap — pinned by a test)
  //   * follows redirects through followSafeRedirects, re-validating every hop
  //   * requires the BYTES to be an image, not the header (the WeebCentral lie — see sniffImageMime)
  //   * caps the response (see MANGA_IMAGE_MAX_BYTES) and streams the rest, never buffering a page
  //   * adds ACAO '*', which is the one capability a direct CDN link cannot have
  // No playlist rewriting, no `pk`/`km`/`aud` transforms, no curl-impersonate, no token minting.
  //
  // TIER 'image', NOT 'proxy'. /proxy's 600/min is sized for one video's segment storm; a reader
  // prefetching chapters is 20-60 requests each. Sharing the bucket lets a manga reader 429 their
  // own video stream and vice versa. RATE_LIMIT_IMAGE (default 300) is its own knob.
  //
  // NO API-KEY GATE, matching /proxy: these URLs are embedded in <img src> and cannot carry headers.
  // The content-type allowlist is what stops that being a general-purpose open relay.
  //
  // SSRF, the non-negotiable part — this guard being absent is a previously-exploited bug class here:
  //   1. `assertUrlSafe(url)` runs BEFORE any socket is opened. SsrfError maps to 400 with the same
  //      `'url' rejected: ...` phrasing /proxy uses.
  //   2. The fetch goes through `followSafeRedirects(...)`, exactly as proxiedUpstream() does, so
  //      every redirect hop is re-validated. A raw fetch() with redirect:'follow' reopens the
  //      vector — the test for this has a live loopback canary behind it, not a status assertion.
  //   3. `ref` is header-injected, never fetched, so it needs no SSRF check — but it IS newline-
  //      stripped, since it lands in a request header.
  //
  // `imageFetch` is injectable for the same reason `fetchImpl`/`lookup` already are in
  // ssrf-guard.mjs: it lets the offline suite drive the REAL guard, the REAL redirect walk and the
  // REAL sniffing against a fake socket layer. server.mjs passes nothing, so production is `fetch`.
  const imageFetch = opts.imageFetch;
  app.get('/manga/image', { preHandler: rateLimit('image') }, async (req, reply) => {
    const target = req.query.url;
    const rawRef = req.query.ref;
    if (!target) return reply.code(400).send({ error: "missing 'url' query param" });
    // A repeated ?url=/?ref= arrives as an ARRAY, which every string-shaped check below would skip.
    // Same bypass that was closed on /manga/read; closed here by construction rather than by luck.
    if (!isSingle(target) || !isSingle(rawRef))
      return reply.code(400).send({ error: "'url' and 'ref' must each be given at most once" });
    try {
      await assertUrlSafe(target);
    } catch (e) {
      if (e instanceof SsrfError) return reply.code(400).send({ error: `'url' rejected: ${e.message}` });
      return reply.code(400).send({ error: "invalid 'url' query param" });
    }
    // STRIP, THEN VALIDATE — the weaker of the two orders, kept because a committed test pins it
    // (`https://mangapill.com/\r\nX-Injected: yes` is accepted here as its stripped form, and is
    // asserted to arrive as one header value). /proxy validates the RAW value and 400s instead;
    // that is the better order and the two should converge. Neither is exploitable — see the
    // measured threat model in ./validators.mjs — so this is a message-quality difference, not a
    // security one. `isRefererUrl` is stricter than the `/^https?:\/\//i` regex it replaces:
    // `https://` and `http://[nonsense` passed that and fail this.
    const ref = headerSafe(rawRef);
    if (ref && !isRefererUrl(ref))
      return reply.code(400).send({ error: "'ref' must be an http(s) url" });

    let up;
    try {
      up = await followSafeRedirects(
        target,
        {
          headers: {
            'User-Agent': UA,
            // What a browser asks for, so a content-negotiating CDN behaves as it does for one.
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Encoding': 'identity', // raw passthrough → the content-length we relay stays true
            ...(ref ? { Referer: ref } : {}),
            // DELIBERATELY NO Origin. See the header: MangaDex answers `Vary: Origin, Referer` and
            // downgrades to a 59 KB placeholder (or 404s) the moment one is present. Never add one,
            // and never reflect the caller's.
          },
          signal: AbortSignal.timeout(MANGA_IMAGE_TIMEOUT_MS),
        },
        imageFetch ? { fetchImpl: imageFetch } : {}
      );
    } catch (e) {
      // A redirect that LANDS in a blocked range throws SsrfError from inside the walk. That is the
      // same class of client error as a blocked initial url, so it gets the same 400 and the same
      // phrasing — never a 502, which would read as "upstream is having a bad day".
      if (e instanceof SsrfError) return reply.code(400).send({ error: `'url' rejected: ${e.message}` });
      return reply.code(502).send({ error: `image upstream fetch failed: ${e.message}` });
    }

    const discard = async () => {
      try {
        await up.body?.cancel?.();
      } catch {
        /* already gone */
      }
    };

    if (up.status < 200 || up.status > 299) {
      await discard();
      // The upstream status is REPORTED, never relayed, and its body is never streamed back: a 403
      // here is a ~4.5 KB Cloudflare block page, and passing that through with a 403 would make the
      // route an HTML relay for anything that answers non-2xx.
      return reply.code(502).send({ error: `image upstream returned ${up.status}` });
    }

    const declared = (up.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (declared && !declared.startsWith('image/')) {
      await discard();
      return reply.code(502).send({ error: `upstream is not an image (content-type: ${declared})` });
    }

    const declaredLength = Number(up.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MANGA_IMAGE_MAX_BYTES) {
      await discard();
      return reply
        .code(502)
        .send({ error: `image is ${declaredLength} bytes, over the ${MANGA_IMAGE_MAX_BYTES}-byte ceiling` });
    }

    if (!up.body) return reply.code(502).send({ error: 'image upstream returned no body' });

    const reader = up.body.getReader();
    let head;
    let done;
    try {
      ({ head, done } = await readHead(reader, SNIFF_BYTES));
    } catch (e) {
      return reply.code(502).send({ error: `image upstream stream failed: ${e.message}` });
    }
    // THE BYTES DECIDE, not the header — see sniffImageMime. This is also what rejects an SVG and
    // an HTML block page mislabelled `image/*`.
    const mime = sniffImageMime(head);
    if (!mime) {
      try {
        await reader.cancel();
      } catch {
        /* already gone */
      }
      return reply.code(502).send({
        error: declared
          ? `upstream declared ${declared} but the bytes are not a supported image`
          : 'upstream body is not a supported image',
      });
    }

    // Release the upstream socket if the reader navigates away mid-page. Mirrors /proxy's cleanup
    // hook; without it a chapter's worth of abandoned prefetches holds connections open.
    reply.raw.on('close', () => {
      reader.cancel().catch(() => {});
    });

    reply.header('Access-Control-Allow-Origin', '*'); // the capability a direct CDN link lacks
    reply.header('Content-Type', mime); // SNIFFED, never the declared one
    reply.header('X-Content-Type-Options', 'nosniff'); // ...and the browser must not re-guess it
    // Mirror the CDN's own policy when it states one; every one of the six does today
    // (`public, max-age=31536000, immutable` down to MangaDex's `public, max-age=604800`). This
    // differs from /manga/read's `no-store` fallback ON PURPOSE: that route caches a list of URLs
    // that can go dead, while this one caches immutable BYTES keyed by an exact URL — a stale hit
    // is the correct image, and is the only thing still working once the upstream URL expires.
    // `Vary` is NOT relayed: our answer varies on neither Origin nor Referer, because we send a
    // fixed Referer and no Origin at all.
    reply.header('Cache-Control', up.headers.get('cache-control') || 'public, max-age=3600');
    for (const h of ['etag', 'last-modified']) {
      const v = up.headers.get(h);
      if (v) reply.header(h, v);
    }
    if (Number.isFinite(declaredLength) && declaredLength > 0) reply.header('Content-Length', String(declaredLength));

    return reply.send(imageBodyStream(head, reader, done, MANGA_IMAGE_MAX_BYTES));
  });
}
