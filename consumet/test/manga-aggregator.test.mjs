// MangaAggregator — the manga-side sibling of AnimeAggregator.
//
// WHAT THIS PROTECTS. Four behaviours that are cheap to break silently and expensive to notice:
//
//   1. FAN-OUT AND FAILURE ISOLATION. Providers are queried concurrently and each one is caught
//      individually. AnimeAggregator learned this the hard way — a provider outage used to vanish
//      into an empty mapping list. Here a throwing provider must degrade to "no candidates from
//      this provider", be LOGGED with its real error, and never sink the call. Remove the
//      per-provider `.catch` in rankedFor and these tests throw instead of asserting.
//
//   2. `chapterNumber` IS A STRING. Providers emit '100.5', 'Extra', 'Oneshot' and (MangaHere)
//      nothing at all. Coercing to Number gives NaN for 'Extra' and reorders decimal chapters.
//      api/src/manga-routes.mjs documents MangaChapter.chapterNumber as a string for exactly this
//      reason, so a regression here is a contract break, not a cosmetic one.
//
//   3. PAGE NUMBERS ARE RE-DERIVED FROM ARRAY ORDER. No provider is reliably 1-based: MangaHere
//      emits 0-based indices, MangaDex parses digits out of the image FILENAME, MangaPill scrapes
//      the literal string "page N" out of the DOM. Trusting the provider's own number produces a
//      reader that starts at page 0 or jumps.
//
//   4. `lang` IS A SKIP, NOT A FILTER. `lang` is first-class on MangaDex, embedded in the chapter
//      id on MangaPark, and NONEXISTENT on MangaHere/MangaPill (English-only sites). A provider
//      that cannot serve the requested language is skipped and named in the `reason`. The failure
//      mode this blocks is answering `lang=pt-br` with English chapters labelled Portuguese.
//
// Plus the two forward seams (B2 id bridges, B3 confidence tiers) — dispatch is wired, so these
// pin that an injected bridge/classifier reaches the envelope AND that a broken one degrades to
// the HONEST label rather than a confident one.
//
// Offline: every provider is a fake injected through the constructor, and the one test that
// exercises the real AniList wiring installs a fake axios adapter on the aggregator's client. No
// test here touches the network.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/meta/manga-aggregator.js');
const MangaAggregator = mod.default ?? mod;
const { defaultProviderRegistry, RateGate } = mod;

/** Swallow the aggregator's diagnostic logs and hand them back, so tests can assert on them. */
const capture = async fn => {
  const logs = [];
  const { warn, error } = console;
  console.warn = (...a) => logs.push(String(a[0]));
  console.error = (...a) => logs.push(String(a[0]));
  try {
    return { out: await fn(), logs };
  } finally {
    console.warn = warn;
    console.error = error;
  }
};

/** A metadata resolver that answers without touching AniList. */
const meta = (titles = ['One Piece', 'ワンピース']) => ({
  resolve: async () => ({ anilistId: '30013', titles, malId: 13 }),
});

/**
 * A fake MangaParser. Deliberately NOT `instanceof MangaParser` — the registry has to accept a
 * duck-typed provider, or this suite could only ever test the three real ones. `calls` records
 * every invocation so fan-out can be asserted rather than inferred.
 */
const fake = (name, impl = {}) => ({
  parser: {
    name,
    calls: [],
    async search(q, page, limit) {
      this.calls.push(`search:${q}:${page}:${limit}`);
      if (impl.searchThrows) throw new Error(`${name} is down`);
      return { results: impl.results ?? [] };
    },
    async fetchMangaInfo(id) {
      this.calls.push(`info:${id}`);
      if (impl.infoThrows) throw new Error(`${name} info exploded`);
      return { id, title: name, chapters: impl.chapters ?? [] };
    },
    async fetchChapterPages(id) {
      this.calls.push(`pages:${id}`);
      return impl.pages ?? [];
    },
  },
  traits: impl.traits,
});

const HIT = [{ id: 'a-1', title: 'One Piece' }];

describe('MangaAggregator fans out across providers and isolates failures', () => {
  test('every provider is queried, and one that throws does not sink the call', async () => {
    const ok = fake('Alpha', { results: HIT });
    const dead = fake('Beta', { searchThrows: true });
    const empty = fake('Gamma', { results: [] });
    const agg = new MangaAggregator({ providers: [ok, dead, empty], metadata: meta() });

    const { out: mappings, logs } = await capture(() => agg.getMappings(30013));

    assert.equal(mappings.length, 1, 'only the provider that matched contributes a mapping');
    assert.equal(mappings[0].provider, 'Alpha');
    assert.ok(mappings[0].score > 0.9, `weak score: ${mappings[0].score}`);
    // fan-out is asserted, not assumed: all three were really asked
    for (const p of [ok, dead, empty])
      assert.equal(p.parser.calls.length, 1, `${p.parser.name} was not queried`);
    // and the two non-answers are distinguishable in the logs — an outage must not look like a miss
    assert.ok(
      logs.some(l => l.includes('Beta') && l.includes('FAILED')),
      `dead provider not logged as a failure: ${JSON.stringify(logs)}`
    );
    assert.ok(
      logs.some(l => l.includes('Gamma') && l.includes('0 results')),
      `empty provider not logged as degraded-but-not-erroring: ${JSON.stringify(logs)}`
    );
  });

  test('the search limit from the registry is forwarded to the provider', async () => {
    // MangaDex fires one EXTRA cover-art request PER RESULT, serially, so the limit is a real cost
    // control rather than a preference.
    const p = fake('Alpha', { results: HIT, traits: { searchLimit: 7 } });
    await capture(() => new MangaAggregator({ providers: [p], metadata: meta() }).getMappings(30013));
    assert.equal(p.parser.calls[0], 'search:One Piece:1:7');
  });

  test('a provider whose chapter fetch explodes falls through to the next one', async () => {
    const dead = fake('Beta', { results: [{ id: 'b-1', title: 'One Piece' }], infoThrows: true });
    const good = fake('Alpha', { results: HIT, chapters: [{ id: 'c1', title: 'Chapter 1' }] });
    const agg = new MangaAggregator({ providers: [dead, good], metadata: meta() });

    const { out, logs } = await capture(() => agg.getChapters(30013));
    assert.equal(out.provider, 'Alpha');
    assert.equal(out.chapters.length, 1);
    assert.ok(logs.some(l => l.includes('Beta') && l.includes('FAILED')));
  });

  test('an alt-title hit rescues a match the primary title would miss', async () => {
    // The one matching signal the anime aggregator has no need for: manga romanisations vary far
    // more than anime ones, and MangaDex ships a rich altTitles array.
    const titles = ['Kaguya-sama wa Kokurasetai', 'かぐや様は告らせたい'];
    const primaryOnly = fake('Alpha', { results: [{ id: 'a-1', title: 'Kaguya Wants To Be Confessed To' }] });
    const withAlts = fake('Alpha', {
      results: [
        { id: 'a-1', title: 'Kaguya Wants To Be Confessed To', altTitles: [{ ja: 'かぐや様は告らせたい' }] },
      ],
    });

    const control = await capture(() =>
      new MangaAggregator({ providers: [primaryOnly], metadata: meta(titles) }).getMappings(1)
    );
    assert.deepEqual(control.out, [], 'control: the primary title alone is below TITLE_FLOOR');

    const { out } = await capture(() =>
      new MangaAggregator({ providers: [withAlts], metadata: meta(titles) }).getMappings(1)
    );
    assert.equal(out.length, 1, 'the alt title should have rescued this match');
    assert.equal(out[0].score, 1);
    assert.equal(out[0].title, 'Kaguya Wants To Be Confessed To', 'reported title stays the provider PRIMARY');
  });
});

describe('MangaAggregator getChapters envelope', () => {
  test('chapterNumber is a STRING and survives 100.5 / Extra / title-only', async () => {
    const p = fake('Alpha', {
      results: HIT,
      chapters: [
        { id: 'c1', title: 'Ch 100.5', chapterNumber: '100.5', volumeNumber: '11', pages: 20 },
        { id: 'c2', title: 'Extra', chapter: 'Extra' }, // MangaPill spells the key `chapter`
        { id: 'c3', title: 'Chapter 7' }, // MangaHere gives no number at all
        { id: 'c4', title: 'numeric', chapterNumber: 100.5 }, // a provider that emits a real Number
        { title: 'no id — unreadable' },
      ],
    });
    const agg = new MangaAggregator({ providers: [p], metadata: meta() });
    const { out } = await capture(() => agg.getChapters(30013));

    assert.equal(out.provider, 'Alpha');
    assert.equal(out.providerId, 'a-1');
    assert.equal(out.matchConfidence, 'unverified');
    assert.equal(out.lang, 'en');
    assert.equal(out.reason, undefined, 'reason is present only when provider is null');
    assert.equal(out.chapters.length, 4, 'the id-less chapter is dropped, not passed through');

    assert.deepEqual(
      out.chapters.map(c => c.chapterNumber),
      ['100.5', 'Extra', '7', '100.5']
    );
    for (const c of out.chapters)
      assert.equal(typeof c.chapterNumber, 'string', `chapterNumber must stay a string: ${c.id}`);
    assert.equal(out.chapters[0].volumeNumber, '11');
    assert.equal(out.chapters[0].pages, 20, 'pages is a COUNT and stays a number');
    // English-only provider: stamping the language is a fact, not a guess
    assert.equal(out.chapters[0].lang, 'en');
  });

  // B1 typed `IChapterUnavailable` but left it unpopulated, because when it was written no
  // provider surfaced the flags. MangaDex now marks its external stubs `readable: false` with the
  // `externalUrl` the pages actually live at. Both halves landed in the same wave, blind to each
  // other, so nothing connected them — and the consequence is not theoretical: live, Chainsaw
  // Man's NEWEST chapter is such a stub, so `getChapters` returned it looking like any other
  // chapter and `getPages` on it threw. A caller cannot pre-filter what is not marked.
  test('a chapter the provider flags as unreadable is marked unavailable, not passed off as normal', async () => {
    const p = fake('Alpha', {
      results: HIT,
      chapters: [
        { id: 'c1', title: 'Real', chapterNumber: '1', readable: true, externalUrl: null },
        {
          id: 'c2',
          title: 'External stub',
          chapterNumber: '2',
          readable: false,
          externalUrl: 'https://www.webnovel.com/comic/1/2',
        },
        // externalUrl alone is enough — a provider may report the link without a readable flag
        { id: 'c3', title: 'Offsite', chapterNumber: '3', externalUrl: 'https://mangaplus.example/x' },
      ],
    });
    const agg = new MangaAggregator({ providers: [p], metadata: meta() });
    const { out } = await capture(() => agg.getChapters(30013));

    assert.equal(out.chapters.length, 3, 'unreadable chapters are MARKED, never dropped');
    assert.equal(out.chapters[0].unavailable, undefined, 'a readable chapter carries no marker');
    assert.deepEqual(out.chapters[1].unavailable, {
      reason: 'external',
      detail: 'https://www.webnovel.com/comic/1/2',
    });
    assert.equal(out.chapters[2].unavailable.reason, 'external');
    assert.equal(out.chapters[2].unavailable.detail, 'https://mangaplus.example/x');
  });

  test('absence of a readable flag is never read as unavailable', async () => {
    // Only MangaDex sets these. Every other provider omits them entirely, and inferring
    // unavailability from a missing field would mark that provider's whole catalogue unreadable.
    const p = fake('Alpha', {
      results: HIT,
      chapters: [{ id: 'c1', title: 'Ch 1', chapterNumber: '1' }],
    });
    const agg = new MangaAggregator({ providers: [p], metadata: meta() });
    const { out } = await capture(() => agg.getChapters(30013));
    assert.equal(out.chapters[0].unavailable, undefined);
  });

  test('nothing found returns an empty list WITH a reason, never a bare []', async () => {
    const agg = new MangaAggregator({
      providers: [fake('Alpha', { results: HIT, chapters: [] })],
      metadata: meta(),
    });
    const { out } = await capture(() => agg.getChapters(30013));
    assert.equal(out.provider, null);
    assert.equal(out.matchConfidence, null);
    assert.deepEqual(out.chapters, []);
    assert.match(out.reason, /empty chapter list/);
  });

  test('a language no provider serves is SKIPPED and named, not silently answered in English', async () => {
    const agg = new MangaAggregator({
      providers: [fake('Alpha', { results: HIT, chapters: [{ id: 'c1', title: 'Chapter 1' }] })],
      metadata: meta(),
    });
    const { out } = await capture(() => agg.getChapters(30013, { lang: 'pt-br' }));
    assert.equal(out.provider, null, 'English chapters must NOT be served as pt-br');
    assert.match(out.reason, /no registered provider serves language 'pt-br'/);
    assert.match(out.reason, /Alpha \(serves en\)/, 'the reason must name what the provider CAN serve');
  });

  test('a requested provider is tried first, then the configured order', async () => {
    const a = fake('Alpha', { results: HIT, chapters: [{ id: 'a-c1', title: 'Chapter 1' }] });
    const b = fake('Beta', { results: [{ id: 'b-1', title: 'One Piece' }], chapters: [{ id: 'b-c1', title: 'Chapter 1' }] });
    const agg = new MangaAggregator({ providers: [a, b], metadata: meta() });
    const { out } = await capture(() => agg.getChapters(30013, { provider: 'beta' }));
    assert.equal(out.provider, 'Beta');
    assert.equal(out.chapters[0].id, 'b-c1');
    assert.ok(!a.parser.calls.includes('info:a-1'), 'Alpha should not have been fetched at all');
  });
});

describe('MangaAggregator getPages normalises what providers disagree about', () => {
  const scraper = () =>
    fake('Alpha', {
      pages: [
        { page: 0, img: 'https://cdn.example/0.jpg' }, // MangaHere-style 0-based
        { page: 1, img: undefined }, // MangaPill-style stale selector
        { page: 2, img: 'https://cdn.example/2.jpg', headerForImage: { Referer: 'https://per-page/' } },
      ],
      traits: {
        imageHeaders: { Referer: 'https://alpha.example/' },
        pageUrlCache: { ttlSeconds: 3600, immutable: false, note: 'scraper cdn' },
      },
    });

  test('pages are 1-based by array order, blanks are dropped, provider numbering is kept', async () => {
    const agg = new MangaAggregator({ providers: [scraper()], metadata: meta() });
    const { out, logs } = await capture(() => agg.getPages('alpha', 'c1'));
    assert.deepEqual(out.pages.map(p => p.page), [1, 2], 'must be 1..N over the SURVIVING pages');
    assert.deepEqual(out.pages.map(p => p.providerPage), [0, 2], "the provider's own numbering is preserved");
    assert.equal(out.pages[0].rawImg, 'https://cdn.example/0.jpg');
    assert.ok(
      logs.some(l => l.includes('NO image url')),
      `a dropped page must be logged, not silently vanish: ${JSON.stringify(logs)}`
    );
  });

  test('img defaults to rawImg, and an injected proxy builder rewrites it with the right Referer', async () => {
    const plain = new MangaAggregator({ providers: [scraper()], metadata: meta() });
    const { out: bare } = await capture(() => plain.getPages('alpha', 'c1'));
    assert.equal(bare.pages[0].img, bare.pages[0].rawImg, 'no proxy injected → img === rawImg');

    // This is the B4 seam: the API layer supplies the /manga/image builder; the aggregator has no
    // business knowing its own origin.
    const agg = new MangaAggregator({
      providers: [scraper()],
      metadata: meta(),
      imageProxy: (raw, ref) => `/manga/image?url=${encodeURIComponent(raw)}&ref=${encodeURIComponent(ref ?? '')}`,
    });
    const { out } = await capture(() => agg.getPages('alpha', 'c1'));
    assert.match(out.pages[0].img, /^\/manga\/image\?url=https%3A%2F%2Fcdn\.example%2F0\.jpg/);
    assert.match(out.pages[0].img, /ref=https%3A%2F%2Falpha\.example%2F/, 'registry Referer is the default');
    assert.match(out.pages[1].img, /ref=https%3A%2F%2Fper-page%2F/, "a page's own headerForImage wins");
    assert.deepEqual(out.headers, { Referer: 'https://alpha.example/' });
    assert.equal(out.cache.ttlSeconds, 3600);
  });

  test('an unknown provider throws, mirroring AnimeAggregator.getSources', async () => {
    const agg = new MangaAggregator({ providers: [scraper()], metadata: meta() });
    await assert.rejects(agg.getPages('nope', 'c1'), /unknown provider: nope/);
  });

  test('a chapter that yields zero pages is reported as possibly-external, not as a transport error', async () => {
    // MangaDex externalUrl / ComicK empty md_images / AsuraScans is_locked all answer 200 with an
    // empty list. That must not read as an outage.
    const agg = new MangaAggregator({ providers: [fake('Alpha', { pages: [] })], metadata: meta() });
    const { out, logs } = await capture(() => agg.getPages('alpha', 'c1'));
    assert.deepEqual(out.pages, []);
    assert.ok(logs.some(l => /external\/locked\/premium/.test(l)), JSON.stringify(logs));
  });
});

describe('MangaAggregator provider registry', () => {
  test('registers exactly the three providers that work today', async () => {
    assert.deepEqual(
      defaultProviderRegistry().map(r => r.parser.name).sort(),
      ['MangaDex', 'MangaHere', 'MangaPill'],
      'brmangas/mangahost/mangareader/readmanga are deleted; vyvymanga/mangakakalot are unrepaired'
    );
  });

  test('cache policy is PER PROVIDER — MangaDex page hosts expire, scanlation CDNs do not', async () => {
    const traits = Object.fromEntries(defaultProviderRegistry().map(r => [r.parser.name, r.traits]));
    assert.ok(
      traits.MangaDex.pageUrlCache.ttlSeconds <= 900,
      'MangaDex at-home hands out a per-request host valid ~15 min'
    );
    assert.ok(
      traits.MangaPill.pageUrlCache.ttlSeconds > traits.MangaDex.pageUrlCache.ttlSeconds,
      'a scanlation CDN must not inherit MangaDex’s short TTL'
    );
    assert.ok(traits.MangaDex.pageUrlCache.note.length > 10, 'the TTL must carry its justification');
  });

  test('id shape is recorded, never assumed — MangaDex is UUIDs, the rest are slugs', async () => {
    const traits = Object.fromEntries(defaultProviderRegistry().map(r => [r.parser.name, r.traits]));
    assert.equal(traits.MangaDex.idShape, 'uuid');
    assert.equal(traits.MangaHere.idShape, 'slug');
    assert.equal(traits.MangaPill.idShape, 'slug');
  });

  test('image Referer is per provider — required on MangaPill, forbidden-ish on MangaDex', async () => {
    const traits = Object.fromEntries(defaultProviderRegistry().map(r => [r.parser.name, r.traits]));
    // empirically: mangapill's CDN answers 403 without this Referer and 200 with it
    assert.equal(traits.MangaPill.imageHeaders.Referer, 'https://mangapill.com/');
    // *.mangadex.network needs none (and must not see an Origin header)
    assert.deepEqual(traits.MangaDex.imageHeaders, {});
  });

  test('the rate gate really attaches to each real provider’s axios client', async () => {
    // Gating fetchChapterPages would gate ONE call that internally fires ~500. The gate is an
    // axios request interceptor on the provider's own client, so it catches the per-page storm.
    const described = new MangaAggregator().describeProviders();
    assert.equal(described.length, 3);
    for (const d of described) assert.equal(d.rateGated, true, `${d.name} is not rate gated`);
    assert.deepEqual(described.find(d => d.name === 'MangaDex').langs, ['en']);
  });

  test('a fake provider with no axios client still works, and says it is un-gated', async () => {
    const agg = new MangaAggregator({ providers: [fake('Alpha', { results: HIT })], metadata: meta() });
    assert.equal(agg.describeProviders()[0].rateGated, false);
    const { out } = await capture(() => agg.getMappings(30013));
    assert.equal(out.length, 1);
  });
});

describe('RateGate request budget is a circuit breaker', () => {
  test('exceeding the budget throws with the label, and the scope closes afterwards', async () => {
    const gate = new RateGate(0); // no throttling interval — budget behaviour only
    await assert.rejects(
      gate.withBudget(2, 'Alpha.fetchChapterPages', async () => {
        for (let i = 0; i < 5; i++) await gate.acquire();
      }),
      /budget exhausted for Alpha\.fetchChapterPages/
    );
    // the finally-block really removed the scope, so a later call is not poisoned
    await gate.withBudget(2, 'Alpha.fetchChapterPages', async () => {
      await gate.acquire();
      await gate.acquire();
    });
  });

  test('a positive rate really spaces requests out', async () => {
    const gate = new RateGate(50); // 20ms apart
    const started = Date.now();
    for (let i = 0; i < 4; i++) await gate.acquire();
    // 4 requests = 3 gaps = >=60ms. Generous lower bound so this is not a timing flake.
    assert.ok(Date.now() - started >= 40, 'requests were not spaced at all');
  });
});

describe('MangaAggregator forward seams (B2 id bridges, B3 confidence tiers)', () => {
  test('an id bridge produces exact-id + via, and skips the provider search entirely', async () => {
    const p = fake('Alpha', { results: [{ id: 'fuzzy-wrong', title: 'One Piece' }] });
    const agg = new MangaAggregator({
      providers: [p],
      metadata: meta(),
      bridges: [{ name: 'malsync', via: 'malsync', lookup: async () => 'exact-42' }],
    });
    const { out } = await capture(() => agg.getMappings(30013));
    assert.equal(out[0].id, 'exact-42', 'a bridge outranks any title fuzziness');
    assert.equal(out[0].matchConfidence, 'exact-id');
    assert.equal(out[0].via, 'malsync');
    assert.equal(p.parser.calls.length, 0, 'a bridge hit means no search request at all');
  });

  test('a throwing bridge falls back to title matching instead of sinking the call', async () => {
    const agg = new MangaAggregator({
      providers: [fake('Alpha', { results: HIT })],
      metadata: meta(),
      bridges: [
        {
          name: 'boom',
          via: 'malsync',
          lookup: async () => {
            throw new Error('bridge down');
          },
        },
      ],
    });
    const { out, logs } = await capture(() => agg.getMappings(30013));
    assert.equal(out[0].id, 'a-1');
    assert.equal(out[0].matchConfidence, 'unverified');
    assert.ok(logs.some(l => l.includes('id bridge boom failed')));
  });

  test('an injected classifier can promote to metadata, and a broken one degrades to unverified', async () => {
    const promoted = new MangaAggregator({
      providers: [fake('Alpha', { results: HIT })],
      metadata: meta(),
      classifier: { classify: () => 'metadata' },
    });
    assert.equal((await capture(() => promoted.getMappings(30013))).out[0].matchConfidence, 'metadata');

    const broken = new MangaAggregator({
      providers: [fake('Alpha', { results: HIT })],
      metadata: meta(),
      classifier: {
        classify: () => {
          throw new Error('nope');
        },
      },
    });
    const { out, logs } = await capture(() => broken.getMappings(30013));
    assert.equal(out[0].matchConfidence, 'unverified', 'a broken classifier must never yield confidence');
    assert.ok(logs.some(l => l.includes('classifier threw')));
  });

  test('with no bridge and no classifier, every mapping is honestly labelled unverified', async () => {
    const agg = new MangaAggregator({ providers: [fake('Alpha', { results: HIT })], metadata: meta() });
    const { out } = await capture(() => agg.getMappings(30013));
    assert.equal(out[0].matchConfidence, 'unverified');
    assert.equal(out[0].via, undefined);
  });
});

describe('MangaAggregator survives an upstream AniList fault', () => {
  /** AniList answers rate limiting with HTTP 200 + populated errors[] + null data. */
  const rateLimited = agg => {
    agg.client.defaults.adapter = async config => ({
      data: { data: null, errors: [{ status: 429, message: 'Too Many Requests' }] },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });
    return agg;
  };

  test('search degrades to [] and logs the fault as UPSTREAM, not as a provider fault', async () => {
    const agg = rateLimited(new MangaAggregator({ providers: [fake('Alpha')] }));
    const { out, logs } = await capture(() => agg.search('one piece'));
    assert.deepEqual(out, []);
    assert.ok(
      logs.some(l => l.includes('populated errors[]') && l.includes('UPSTREAM')),
      `the 200+errors[] case must be logged or it reads as "no results": ${JSON.stringify(logs)}`
    );
  });

  test('getChapters degrades to a reason and never queries a provider with no title', async () => {
    const p = fake('Alpha');
    const agg = rateLimited(new MangaAggregator({ providers: [p] }));
    const { out, logs } = await capture(() => agg.getChapters(30013));
    assert.equal(out.provider, null);
    assert.ok(out.reason);
    assert.equal(p.parser.calls.length, 0, 'searching with an empty title is a wasted upstream request');
    assert.ok(logs.some(l => l.includes('yielded NO titles')));
  });
});
