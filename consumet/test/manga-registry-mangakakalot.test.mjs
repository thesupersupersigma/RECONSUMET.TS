// The MangaKakalot registry entry: is the provider REACHABLE, and are its traits MEASUREMENTS?
//
// WHY THIS FILE EXISTS. The previous wave built and tested MangaKakalot's alias bridge — the thing
// that turns `demon slayer` into `kimetsu-no-yaiba` — and it genuinely worked. It was also dead
// code: the provider was never added to `defaultProviderRegistry()`, so nothing over HTTP could
// reach it. `GET /manga/chapters/:id?provider=mangakakalot` answered 400 with a `providers` list of
// exactly six names, and the whole feature delivered nothing. Registration is the fix, and
// registration is a one-line change that NO TYPE CHECK CAN GUARD: adding, removing or misspelling a
// registry entry compiles perfectly either way. This suite is the only thing standing between the
// working set and a silent regression to six.
//
// WHY IT ALSO PINS THE TRAIT VALUES. `DEFAULT_TRAITS` exists so a caller can drop in a provider
// without traits, and it is deliberately pessimistic. Inheriting it here would be a bug of a
// specific and nasty shape: `DEFAULT_TRAITS.imageHeaders` is `{}`, and this provider's CDN answers
// 403 (4,573 bytes of Cloudflare HTML, Content-Type text/html) to a request with no Referer. A
// registry entry that looked complete would therefore produce a chapter list, a page list, and 55
// broken images — success everywhere except the only place a reader looks. So every trait below is
// asserted against the number that was MEASURED, not merely against "something was set".
//
// EVERY EXPECTATION IN HERE IS A LIVE MEASUREMENT taken 2026-08-14 against www.manganato.gg from a
// residential IP; the probe log is quoted inline at each assertion. The suite itself makes NO
// network calls — the only provider method it exercises is stubbed.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const agg = require('../dist/providers/meta/manga-aggregator.js');

const MangaAggregator = agg.default ?? agg;
const { defaultProviderRegistry, DEFAULT_TRAITS } = agg;

/** The exact Referer the image CDN accepts. The trailing slash is the point — see below. */
const IMAGE_REFERER = 'https://www.manganato.gg/';

const entryFor = name => defaultProviderRegistry().find(e => e.parser.name === name);

describe('manga registry: MangaKakalot is registered and reachable', () => {
  // ---------------------------------------------------------------------------------------------
  // 1. THE GAP ITSELF.
  // ---------------------------------------------------------------------------------------------
  test('MangaKakalot is in the default registry', () => {
    assert.ok(
      entryFor('MangaKakalot'),
      'MangaKakalot is missing from defaultProviderRegistry(). Its alias bridge (demon slayer -> ' +
        'kimetsu-no-yaiba) is then unreachable over HTTP and the feature is dead code — which is ' +
        'exactly the state this test was written to end.'
    );
  });

  test('the working set is exactly these seven, in this order', () => {
    // Pinned as a LIST, not just a membership check, because the order is load-bearing: getChapters
    // breaks confidence ties by registry position, and the 400 body of an unknown-provider request
    // is this array verbatim. A provider quietly appearing here is as much a regression as one
    // quietly disappearing.
    assert.deepEqual(
      defaultProviderRegistry().map(e => e.parser.name),
      ['MangaDex', 'MangaHere', 'MangaPill', 'AsuraScans', 'FlameComics', 'WeebCentral', 'MangaKakalot']
    );
  });

  test('the aggregator resolves it by name, case-insensitively, the way the API layer does', () => {
    // api/src/manga-routes.mjs canonicalises `?provider=` against `agg.providerNames` and 400s on a
    // miss, so this getter IS the HTTP surface. Verified live over HTTP against the real route
    // module: `?provider=mangakakalot` and `?provider=MangaKakalot` both resolve to
    // providerId 'kimetsu-no-yaiba'.
    const names = new MangaAggregator().providerNames;
    assert.ok(names.includes('MangaKakalot'));
    assert.ok(names.some(n => n.toLowerCase() === 'mangakakalot'));
  });

  test('the rate gate actually attached to it', () => {
    // describeProviders().rateGated is a structural probe, not a claim: it reports whether the
    // interceptor really got installed on the provider's axios client. An un-gated provider still
    // works, so nothing else would notice — and a cold search here is ~20 upstream requests.
    const described = new MangaAggregator().describeProviders().find(p => p.name === 'MangaKakalot');
    assert.ok(described, 'MangaKakalot absent from describeProviders()');
    assert.equal(described.rateGated, true);
  });

  // ---------------------------------------------------------------------------------------------
  // 2. THE TRAITS ARE MEASUREMENTS.
  // ---------------------------------------------------------------------------------------------
  describe('traits are the measured values, not DEFAULT_TRAITS', () => {
    const traits = () => entryFor('MangaKakalot').traits;

    test('imageHeaders is the ONE exact Referer the CDN accepts — trailing slash included', () => {
      // THE MEASUREMENT (live, against a real page image, five ways):
      //   no Referer                                                  -> 403, 4,573 bytes of CF HTML
      //   'https://www.manganato.gg'   (baseUrl, no trailing slash)   -> 403, same 4,573 bytes
      //   'https://www.manganato.gg/'                                 -> 200, image/webp, 205,680 B
      //   'https://www.manganato.gg/manga/kimetsu-no-yaiba/chapter-1' -> 403  (the real page URL!)
      //   'https://evil.example.com/'                                 -> 403
      // Re-confirmed over HTTP end to end: GET /manga/image?url=...&ref=<this> returns 200
      // image/webp with RIFF/WEBP magic, and the same URL with no ?ref= returns 502 "image upstream
      // returned 403". One character wrong and every page in every chapter is a broken image.
      assert.deepEqual(traits().imageHeaders, { Referer: IMAGE_REFERER });
      assert.ok(traits().imageHeaders.Referer.endsWith('/'), 'the trailing slash is load-bearing');
      assert.notEqual(
        traits().imageHeaders.Referer,
        'https://www.manganato.gg',
        'the bare origin (= the provider baseUrl) is one of the forms that 403s'
      );
      // And the trap this whole block guards: inheriting the default would 403 every image.
      assert.notDeepEqual(traits().imageHeaders, DEFAULT_TRAITS.imageHeaders);
    });

    test('idShape is a slug, and the CHAPTER id is not the same shape', () => {
      // Measured: series ids are 'kimetsu-no-yaiba' / 'one-piece'. Chapter ids are
      // '<slug>/<chapter-slug>' ('kimetsu-no-yaiba/chapter-1') and therefore CONTAIN A SLASH — the
      // same gotcha AsuraScans documents. idShape describes the SERIES id only.
      assert.equal(traits().idShape, 'slug');
    });

    test('langModel/langs state a single-language site', () => {
      assert.equal(traits().langModel, 'none');
      assert.deepEqual([...traits().langs], ['en']);
    });

    test('requestsPerSecond is the chosen 6, not the pessimistic default', () => {
      // Measured ceiling: 12 parallel requests -> 12x200 in 458 ms (~26 req/s); 30 serial -> 30x200,
      // no 429, no Retry-After, no cf-mitigated. No throttle was found, so 6 is a deliberate policy
      // choice on a Cloudflare-fronted host, documented as such at the entry. It is pinned here
      // because it also gates the alias bridge's AniList and MAL-Sync calls (they share the
      // provider's axios client), so silently reverting it to the default slows alias resolution.
      assert.equal(traits().requestsPerSecond, 6);
      assert.notEqual(traits().requestsPerSecond, DEFAULT_TRAITS.requestsPerSecond);
    });

    test('searchLimit is 20 because it was MEASURED at 20, not because 20 is the default', async () => {
      // This is the one trait whose measured value coincides with DEFAULT_TRAITS, so "it differs
      // from the default" cannot be the assertion — the measurement has to be REPRODUCED instead.
      //
      // The fact: `search()` is `(query, page)`. The third argument the aggregator passes
      // (`entry.traits.searchLimit`, see rankedMatches) is silently ignored, and the page size is
      // the provider's own RESULTS_PER_PAGE constant. Live measurement: search('one', 1, 5) returned
      // 20 rows out of 2,470 matches. Same shape as WeebCentral's un-settable 32, different cause.
      //
      // Reproduced here offline against a 40-slug catalogue, all of which match, with the aggregator's
      // own call shape and a limit of 5 — if the provider ever starts honouring the limit, this goes
      // red and searchLimit becomes a real knob that must be re-chosen rather than re-measured.
      assert.equal(traits().searchLimit, 20);

      const ORIGIN = 'https://www.manganato.gg';
      const slugs = Array.from({ length: 40 }, (unused, i) => `one-series-${i}`);
      const routes = {
        [`${ORIGIN}/sitemap.xml`]: `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex><sitemap><loc>${ORIGIN}/sitemap-comic-1.xml</loc></sitemap></sitemapindex>`,
        [`${ORIGIN}/sitemap-comic-1.xml`]: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>${slugs
          .map(s => `<url><loc>${ORIGIN}/manga/${s}</loc></url>`)
          .join('')}</urlset>`,
      };
      const seen = [];
      const parser = entryFor('MangaKakalot').parser;
      parser.client.defaults.adapter = async config => {
        const url = String(config.url);
        seen.push(url);
        if (Object.prototype.hasOwnProperty.call(routes, url))
          return { data: routes[url], status: 200, statusText: '', headers: {}, config };
        // Every /manga/<slug> 404s: the top-hit summary fetch is best-effort, and 404ing it keeps
        // this test about the page size and nothing else.
        return { data: '404', status: 404, statusText: '', headers: {}, config };
      };
      // The alias bridge would reach AniList/MAL-Sync for a non-slug query; off, so this stays a
      // measurement of the page size alone.
      parser.useAliasResolution = false;
      parser.clearSearchIndex();

      const res = await parser.search('one-series', 1, 5);
      assert.equal(res.totalResults, 40, 'fixture did not match all 40 slugs');
      assert.equal(
        res.results.length,
        20,
        `search(q, 1, 5) returned ${res.results.length} rows — the provider now honours a limit, so ` +
          'searchLimit is no longer "20 because 20 is all it can give"'
      );
      assert.ok(
        seen.every(u => u.startsWith(ORIGIN)),
        `search reached off-site with the alias bridge disabled: ${seen.filter(u => !u.startsWith(ORIGIN))}`
      );
    });

    test('budgets are sized from the measured request counts', () => {
      // Measured: fetchMangaInfo('one-piece') = 4 requests (1 detail + 3 chapter-API pages @500) for
      // 1,376 chapters; fetchChapterPages = exactly 1; a cold search = 20 (sitemap index + 10 shards
      // + 1 AniList + 4 MAL-Sync + 2 slug confirmations + 1 summary), a warm one = 1.
      assert.deepEqual(traits().budgets, { chapterList: 12, chapterPages: 8, search: 40 });
      // search MUST exceed the 20 a cold search really costs, with room for the provider's own
      // worst case (1 + MAX_SITEMAP_SHARDS 20 + 1 + ALIAS_MAX_CANDIDATES 4 + ALIAS_PROBE_BUDGET 2 +
      // BROWSE_LISTINGS 3 + 1 = 32). An exhausted budget THROWS and costs the whole mapping, and
      // DEFAULT_TRAITS.budgets.search (32) is too tight to hold that worst case with any margin.
      assert.ok(
        traits().budgets.search > 32,
        `search budget ${traits().budgets.search} does not clear the measured worst case of 32`
      );
      assert.notDeepEqual(traits().budgets, DEFAULT_TRAITS.budgets);
    });

    test('pageUrlCache records the positional-path measurement', () => {
      const cache = traits().pageUrlCache;
      assert.equal(cache.ttlSeconds, 3600);
      // NEVER immutable: the path is /<slug>/<chapter>/<index>.webp — positional, not
      // content-addressed — so a re-upload replaces the bytes at the same URL.
      assert.equal(cache.immutable, false);
      assert.match(cache.note, /2xstorage/);
      assert.match(cache.note, /POSITIONAL/);
      assert.notDeepEqual(cache, DEFAULT_TRAITS.pageUrlCache);
      assert.doesNotMatch(
        cache.note,
        /unregistered provider/,
        'this is the DEFAULT_TRAITS placeholder note — the entry inherited instead of measuring'
      );
    });

    test('taken together the traits are not the defaults', () => {
      assert.notDeepEqual(traits(), DEFAULT_TRAITS);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 3. THE TRAIT REACHES THE ANSWER. Offline, but through the REAL aggregator and the REAL entry:
  //    only the one network call is stubbed.
  // ---------------------------------------------------------------------------------------------
  test('getPages hands the measured Referer to both the caller and the image proxy', async () => {
    const proxied = [];
    const aggregator = new MangaAggregator({
      imageProxy: (rawImg, referer) => {
        proxied.push({ rawImg, referer });
        return `/manga/image?url=${encodeURIComponent(rawImg)}&ref=${encodeURIComponent(referer ?? '')}`;
      },
    });

    // Stub the single upstream call. Note NO per-page `headerForImage`: the real provider stamps one,
    // and getPages prefers it, so leaving it off is what forces the REGISTRY trait to be the source.
    // That is the value /manga/image is handed, so it is the one that has to be right here.
    const registered = aggregator.providers.find(e => e.parser.name === 'MangaKakalot');
    assert.ok(registered, 'MangaKakalot not registered — nothing to exercise');
    registered.parser.fetchChapterPages = async () => [
      { img: 'https://img-r1.2xstorage.com/kimetsu-no-yaiba/1/0.webp', page: 0 },
      { img: 'https://img-r1.2xstorage.com/kimetsu-no-yaiba/1/1.webp', page: 1 },
    ];

    const res = await aggregator.getPages('mangakakalot', 'kimetsu-no-yaiba/chapter-1');

    assert.equal(res.provider, 'MangaKakalot');
    assert.deepEqual(res.headers, { Referer: IMAGE_REFERER });
    assert.equal(res.cache.ttlSeconds, 3600);
    assert.equal(res.pages.length, 2);
    // page is re-derived 1-based from array order; the provider's own 0-based index is kept aside.
    assert.deepEqual(
      res.pages.map(p => [p.page, p.providerPage]),
      [
        [1, 0],
        [2, 1],
      ]
    );
    assert.deepEqual(
      proxied.map(p => p.referer),
      [IMAGE_REFERER, IMAGE_REFERER],
      'the registry Referer must reach the image proxy — with {} it would be undefined and 403'
    );
  });

  // ---------------------------------------------------------------------------------------------
  // 4. VYVYMANGA STAYS OUT, ON PURPOSE.
  // ---------------------------------------------------------------------------------------------
  test('VyvyManga is deliberately NOT registered', () => {
    // Its pipeline runs (mangavyvy.net, 1,298 One Piece chapters, real JPEGs needing no Referer),
    // but the aggregator searches every provider with AniList's PRIMARY title, and measured live
    // search('Demon Slayer: Kimetsu no Yaiba') returns exactly ONE result: manga 72754, a
    // one-chapter doujinshi — while the real series (1373, 235 chapters) is only reachable by the
    // shorter query 'Demon Slayer'. No id bridge names this provider either, so the mapping can
    // never rise above 'unverified' and be caught. Registering it would serve the wrong comic
    // confidently. Full reasoning and the second defect (queries are not percent-encoded, so
    // 'Tokyo #1' truncates at the '#') are in the block comment after defaultProviderRegistry().
    assert.equal(
      defaultProviderRegistry().find(e => /vyvy/i.test(e.parser.name)),
      undefined,
      'VyvyManga was registered — re-read the block comment after defaultProviderRegistry(): it maps ' +
        'Demon Slayer to a one-chapter doujinshi. Fix vyvymanga.ts search first, then re-measure.'
    );
  });
});
