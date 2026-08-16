// A test harness that wires the REAL api/src/manga-routes.mjs plugin to the REAL
// consumet MangaAggregator — not a fake one — and serves it over real HTTP, fully offline.
//
// WHY THIS EXISTS AND WHY IT IS NOT manga-fake-server.mjs. That fixture registers
// `makeFakeAggregator(...)`, so every chapter field a test reads there was written by the fixture
// itself. That is the right tool for proving the WIRING (envelopes, status codes, deadlines), and
// the wrong one for proving a DATA CONTRACT: a test built on it returns whatever the fake hands
// back, so no change to the aggregator's own normalisation could ever fail it. The
// `releaseDate` / `releaseDatePrecision` / `releaseDateRaw` guarantee documented in
// manga-routes.mjs was consequently enforced only by consumet's suite, and the api suite stayed
// green under a mutation of the aggregator's date handling.
//
// HOW IT STAYS OFFLINE WHILE USING THE REAL AGGREGATOR. `MangaAggregator` takes injected
// `providers` (bare parsers or `{parser, traits}` entries) — the technique consumet's own
// test/manga-aggregator.test.mjs already uses. The providers here are duck-typed fakes that emit
// known RAW date strings measured off the live providers; everything downstream of them —
// `firstText`, `releaseDateFields`, `normalizeReleaseDate` — is the real, shipped code path.
//
// The other three constructor seams are left at their DEFAULTS on purpose, because the defaults
// are what production runs:
//   - metadata IS injected (it is the one layer that would POST to AniList unconditionally),
//   - bridges are NOT: each returns null without issuing a request when it cannot name the given
//     provider's id space, and the fake metadata states no `malId`, so MAL-Sync has no key either.
//     No fake here is named 'MangaDex', which is the only name MangaDexLinksBridge answers for.
//   - the classifier is NOT: it issues no requests at all.
// That reasoning is asserted rather than trusted — `netAttempts` records every request that
// reaches the aggregator's axios adapter, and the suite asserts it stayed empty.

import Fastify from 'fastify';
import mangaRoutes, { createMangaAggregator } from '../../src/manga-routes.mjs';
// Imported exactly as api/src/server.mjs imports it, so this exercises the same bundle the
// deployed server loads.
import pkg from '../../../consumet/dist/index.js';

const { MangaAggregator } = pkg;

/**
 * A duck-typed MangaParser. Deliberately NOT `instanceof MangaParser`, mirroring the consumet
 * suite: the registry has to accept a duck-typed provider or an offline test could only ever
 * drive the seven real ones.
 */
export const dateProvider = (name, chapters) => ({
  parser: {
    name,
    async search() {
      // One exact-title hit, so tier-1 ranking clears TITLE_FLOOR and this provider becomes a
      // candidate. Nothing else about the match matters here.
      return { results: [{ id: `${name.toLowerCase()}-one-piece`, title: 'One Piece' }] };
    },
    async fetchMangaInfo(id) {
      return { id, title: 'One Piece', chapters };
    },
    async fetchChapterPages() {
      return [];
    },
  },
});

/**
 * Builds the app. Returns the base URL, the recorded network attempts (must stay empty), and a
 * close handle.
 *
 * @param {Array<{parser: object}>} providers duck-typed provider entries
 */
export const startReleaseDateApp = async providers => {
  const agg = createMangaAggregator(MangaAggregator, {
    providers,
    // The ONLY injected layer. B1's AniList resolver would POST to graphql.anilist.co on every
    // call; the ids and titles it would return are irrelevant to a date contract.
    metadata: {
      resolve: async () => ({ anilistId: '30013', titles: ['One Piece'] }),
    },
  });

  // Proof, not assumption, that nothing above reaches a socket. Any request that gets as far as
  // the aggregator's shared axios client is recorded AND fails loudly rather than hanging on a
  // DNS lookup while the suite's timeout runs down.
  const netAttempts = [];
  agg.client.defaults.adapter = async config => {
    netAttempts.push(`${String(config.method ?? 'get').toUpperCase()} ${config.url}`);
    throw new Error(`offline test attempted a real request: ${config.url}`);
  };

  const app = Fastify({ logger: false });
  await app.register(mangaRoutes, { aggregator: agg });
  await app.listen({ port: 0, host: '127.0.0.1' });

  return {
    base: `http://127.0.0.1:${app.server.address().port}`,
    netAttempts,
    aggregator: agg,
    close: () => app.close(),
  };
};

// ---------------------------------------------------------------------------------------------
// THE RAW STRINGS. Every one is a shape the census in consumet/src/providers/meta/
// manga-release-date.ts records as MEASURED off a live provider, except where marked.
// ---------------------------------------------------------------------------------------------

/**
 * AsuraScans emitted all five of these spellings from ONE endpoint inside ONE chapter list (its
 * serialiser trims trailing zeros from the fractional part). They are the reason "already ISO" is
 * not a reason to leave a value alone.
 */
export const ASURA_CHAPTERS = [
  { id: 'as-1', title: 'Chapter 1', chapterNumber: '1', releaseDate: '2026-03-19T06:13:09Z' },
  { id: 'as-2', title: 'Chapter 2', chapterNumber: '2', releaseDate: '2026-05-27T17:51:06.065Z' },
  { id: 'as-3', title: 'Chapter 3', chapterNumber: '3', releaseDate: '2026-08-05T16:45:52.287297Z' },
  { id: 'as-4', title: 'Chapter 4', chapterNumber: '4', releaseDate: '2026-08-12T17:00:56.65804Z' },
  { id: 'as-5', title: 'Chapter 5', chapterNumber: '5', releaseDate: '2026-04-10T14:43:10.75Z' },
  // MangaKakalot's six-digit spelling, and a zoned-offset one. The offset is not observed on any
  // registered provider; it is here because the grammar accepts it and a silently-dropped offset
  // is an eight-hour error, not a formatting one.
  { id: 'as-6', title: 'Chapter 6', chapterNumber: '6', releaseDate: '2025-09-20T11:03:09.000000Z' },
  { id: 'as-7', title: 'Chapter 7', chapterNumber: '7', releaseDate: '2025-09-20T11:03:09+09:00' },
];

/** MangaHere. Note the MISSPELLED key — the provider really does emit `releasedDate`. */
export const MANGAHERE_CHAPTERS = [
  { id: 'mh-1', title: 'Chapter 1', chapterNumber: '1', releasedDate: 'Nov 05,2018' },
  { id: 'mh-2', title: 'Chapter 2', chapterNumber: '2', releasedDate: 'Jan 09,2025' },
  { id: 'mh-3', title: 'Chapter 3', chapterNumber: '3', releasedDate: 'September 3, 2019' },
  // Already-canonical ISO calendar date: 'day', and NO `raw`, because nothing was rewritten.
  { id: 'mh-4', title: 'Chapter 4', chapterNumber: '4', releasedDate: '2018-11-05' },
  // A named month that is not a real date. Must NOT roll forward to Mar 2 — it is passed through.
  { id: 'mh-5', title: 'Chapter 5', chapterNumber: '5', releasedDate: 'Feb 30,2025' },
];

/** Values that must survive untouched. Guessing any of them invents a date. */
export const PASSTHROUGH_CHAPTERS = [
  // DD/MM and MM/DD are both live readings — 3 April or 4 March.
  { id: 'pt-1', title: 'Chapter 1', chapterNumber: '1', releaseDate: '03/04/2018' },
  { id: 'pt-2', title: 'Chapter 2', chapterNumber: '2', releaseDate: '2 days ago' },
  { id: 'pt-3', title: 'Chapter 3', chapterNumber: '3', releaseDate: 'Nov 2018' },
  { id: 'pt-4', title: 'Chapter 4', chapterNumber: '4', releaseDate: '2018' },
  // A date-TIME with NO zone. Resolving it means inventing a zone, i.e. up to 26 hours of error.
  { id: 'pt-5', title: 'Chapter 5', chapterNumber: '5', releaseDate: '2025-09-20T11:03:09' },
  // The documented whitespace caveat: trimming alone never sets `raw`.
  { id: 'pt-6', title: 'Chapter 6', chapterNumber: '6', releaseDate: '   03/04/2018   ' },
];

/** MangaPill states no date on any chapter. Permanent, not a gap. `''` is the same "no date". */
export const NO_DATE_CHAPTERS = [
  { id: 'mp-1', title: 'Chapter 1', chapterNumber: '1' },
  { id: 'mp-2', title: 'Chapter 2', chapterNumber: '2' },
  { id: 'mp-3', title: 'Chapter 3', chapterNumber: '3', releaseDate: '' },
  { id: 'mp-4', title: 'Chapter 4', chapterNumber: '4', releaseDate: '   ' },
];
