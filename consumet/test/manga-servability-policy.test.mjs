// The default-provider selection policy: CONFIDENCE RANKS, SERVABILITY ADMITS.
//
// THE BUG THIS EXISTS FOR. Solo Leveling is AniList manga 105398. MangaDex asserts that AniList id
// on its own record (`attributes.links.al`), so the `mangadex-links.al` bridge names the MangaDex
// id outright and the mapping is 'exact-id' — the strongest signal the aggregator has, and it is
// CORRECT. But all 24 of its English chapters are `externalUrl` stubs (the pages live on
// webnovel.com), so every chapter comes back `unavailable: { reason: 'external' }` and
// `fetchChapterPages` throws on all of them. `getChapters` returned that list because it was
// non-empty, and the obvious user path — list chapters, read the first one — 502'd on a top-10
// title while five other registered providers sat there with real images.
//
// WHAT IS PINNED HERE, and what each assertion fails on if the policy is reverted:
//
//   1. THE TWO PROPERTIES STAY SEPARATE. Id confidence answers "is this the right series"; it says
//      nothing about "can this provider serve pages". So readability is an ADMISSIBILITY FILTER —
//      a candidate that lists chapters but can serve NONE of them is skipped exactly like one whose
//      list came back empty — and it is NEVER a sort key. Revert the filter and test 1 returns the
//      all-external provider.
//
//   2. CONFIDENCE IS STILL THE PRIMARY SORT, and now across providers rather than only within one.
//      The fall-through must not hand an 'unverified' title guess to a caller while an 'exact-id'
//      provider sits later in the registry. Tests 2 and 3.
//
//   3. THE STRONG-BUT-UNREADABLE ANSWER IS NEVER THROWN AWAY. If nothing admissible exists, the
//      held list is returned as-is — provider, confidence, `via` and every `unavailable` marker
//      intact — plus a `reason`. The caller can never get LESS than it got before the policy.
//      Tests 4 and 5.
//
//   4. GAPS ARE NOT THE SAME AS A WALL. A list with SOME unreadable chapters (Chainsaw Man's newest
//      chapter is an external stub; an AsuraScans early-access chapter is `locked` on a timer) is
//      served, marked, and NOT demoted. Zero readable is a boolean, not a threshold — the moment
//      this becomes a percentage it starts demoting legitimately mostly-licensed series. Test 6.
//
//   5. THE NON-DEGRADED ENVELOPE IS UNCHANGED. `reason` stays absent on an ordinary success, so
//      `reason == null` still means "nothing to explain". Test 7. (This is what stops the policy
//      from becoming a contract break for every existing client.)
//
// Offline: every provider is a fake injected through the constructor, no bridge, no network.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/meta/manga-aggregator.js');
const MangaAggregator = mod.default ?? mod;

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

const meta = (titles = ['Solo Leveling', '나 혼자만 레벨업']) => ({
  resolve: async () => ({ anilistId: '105398', titles, malId: 121496 }),
});

/**
 * A duck-typed MangaParser. Same shape the sibling suite uses — the registry must accept one.
 * `impl.trace`, when given, is a SHARED array every provider appends its `fetchMangaInfo` to, which
 * is the only way to assert the ORDER of the walk across providers rather than merely that each was
 * reached (they are searched concurrently, but the chapter walk is strictly sequential).
 */
const fake = (name, impl = {}) => ({
  parser: {
    name,
    calls: [],
    async search(q, page, limit) {
      this.calls.push(`search:${q}:${page}:${limit}`);
      return { results: impl.results ?? [] };
    },
    async fetchMangaInfo(id) {
      this.calls.push(`info:${id}`);
      impl.trace?.push(name);
      return { id, title: name, chapters: impl.chapters ?? [] };
    },
    async fetchChapterPages(id) {
      this.calls.push(`pages:${id}`);
      return impl.pages ?? [];
    },
  },
  traits: impl.traits,
});

const HIT = [{ id: 'sl-1', title: 'Solo Leveling' }];
const BERSERK = [{ id: 'bk-1', title: 'Berserk' }];

/**
 * The live MangaDex shape for Solo Leveling, reduced: `readable: false` plus the webnovel.com
 * `externalUrl` the pages really live at, on EVERY chapter.
 */
const allExternal = n =>
  Array.from({ length: n }, (_, i) => ({
    id: `md-${i + 1}`,
    title: `Chapter ${i + 1}`,
    chapterNumber: String(i + 1),
    readable: false,
    externalUrl: `https://www.webnovel.com/comic/solo-leveling/ch-${i + 1}`,
  }));

const readableChapters = (prefix, n) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}`, title: `Chapter ${i + 1}`, chapterNumber: String(i + 1) }));

/** Promote exactly the named provider to 'exact-id', the way a real id bridge would. */
const bridgeFor = (providerName, id) => [
  {
    name: 'fake-bridge',
    via: 'mangadex-links.al',
    lookup: async (_meta, provider) => (provider.toLowerCase() === providerName.toLowerCase() ? id : null),
  },
];

describe('getChapters: servability admits, confidence ranks', () => {
  test('1. an exact-id provider that can serve NO chapter falls through to one that can', async () => {
    // THE SOLO LEVELING CASE, end to end. MangaDex is the right record and knows it; it just cannot
    // hand over pixels. Before the policy this returned MangaDex's 24 stubs and /manga/read 502'd.
    const dex = fake('FakeDex', { results: HIT, chapters: allExternal(24) });
    const scan = fake('FakeScans', { results: HIT, chapters: readableChapters('as', 200) });
    const agg = new MangaAggregator({
      providers: [dex, scan],
      metadata: meta(),
      bridges: bridgeFor('FakeDex', 'md-uuid'),
    });

    const { out, logs } = await capture(() => agg.getChapters(105398));

    assert.equal(out.provider, 'FakeScans', 'the provider that can actually serve pages must answer');
    assert.equal(out.chapters.length, 200);
    assert.equal(
      out.chapters.filter(c => c.unavailable).length,
      0,
      'the answer a reader gets must contain something readable'
    );
    assert.equal(out.reason, undefined, 'this is an ordinary success — nothing to explain');
    // The skipped provider WAS tried and the skip is explicable. A silent fall-through here would
    // be indistinguishable from MangaDex never having matched at all.
    assert.ok(dex.parser.calls.includes('info:md-uuid'), 'the exact-id provider must still be tried FIRST');
    assert.ok(
      logs.some(l => l.includes('FakeDex') && /EVERY ONE is unreadable/.test(l) && l.includes('external')),
      `the skip must be logged with its real reason: ${JSON.stringify(logs)}`
    );
    // And the log must say the MATCH was fine — otherwise this reads as a bad mapping and sends the
    // next person to debug the bridge.
    assert.ok(
      logs.some(l => l.includes('the match is fine') && l.includes('exact-id')),
      `the log must not blame the mapping: ${JSON.stringify(logs)}`
    );
  });

  test('2. servability is NOT a sort key: an exact-id provider with readable chapters still wins', async () => {
    // The obvious wrong fix is "prefer whoever has the most readable chapters", or "demote
    // MangaDex". This is Berserk: 425/425 readable on the exact-id provider, and a title-matched
    // scanlation site sitting EARLIER in the registry with more chapters. Confidence must decide.
    const scan = fake('FakeScans', { results: BERSERK, chapters: readableChapters('as', 900) });
    const dex = fake('FakeDex', { results: BERSERK, chapters: readableChapters('md', 425) });
    const agg = new MangaAggregator({
      providers: [scan, dex], // registry order deliberately puts the weaker match first
      metadata: meta(['Berserk']),
      bridges: bridgeFor('FakeDex', 'md-uuid'),
    });

    const { out } = await capture(() => agg.getChapters(30002));
    assert.equal(out.provider, 'FakeDex', 'a readable exact-id provider must never be demoted');
    assert.equal(out.matchConfidence, 'exact-id');
    assert.equal(out.via, 'mangadex-links.al');
    assert.equal(out.chapters.length, 425);
    assert.ok(!scan.parser.calls.includes('info:bk-1'), 'the weaker match should not even be fetched');
  });

  test('3. the fall-through is ordered by CONFIDENCE, not by registry position', async () => {
    // The half-fix this blocks: "skip the unreadable one and take the next in the list". The next
    // in the list is a title-similarity guess; two slots further down is an id-bridged match. A
    // fall-through that takes the guess is how you end up serving the wrong series silently, which
    // is a worse failure than serving no pages because nothing reports it.
    const dex = fake('FakeDex', { results: HIT, chapters: allExternal(24) });
    const guess = fake('FakeGuess', { results: HIT, chapters: readableChapters('gs', 10) });
    const bridged = fake('FakeBridged', { results: HIT, chapters: readableChapters('br', 179) });
    const agg = new MangaAggregator({
      providers: [dex, guess, bridged],
      metadata: meta(),
      bridges: [
        {
          name: 'fake-bridge',
          via: 'malsync',
          lookup: async (_m, p) =>
            ({ fakedex: 'md-uuid', fakebridged: 'br-slug' })[p.toLowerCase()] ?? null,
        },
      ],
    });

    const { out } = await capture(() => agg.getChapters(105398));
    assert.equal(out.provider, 'FakeBridged', 'the id-bridged provider must outrank the title guess');
    assert.equal(out.matchConfidence, 'exact-id');
    assert.equal(out.chapters.length, 179);
    assert.ok(
      !guess.parser.calls.includes('info:sl-1'),
      'the unverified provider must not have been fetched at all — confidence is the sort key'
    );
  });

  test('4. when NOTHING is readable anywhere, the strongest list is returned marked, never dropped', async () => {
    // The "let the caller choose" option, kept as the LAST resort rather than the first answer.
    // Returning { provider: null, chapters: [] } here would discard evidence already paid for: the
    // series is identified, the chapter list is real, and each chapter says why it cannot be read.
    const dex = fake('FakeDex', { results: HIT, chapters: allExternal(24) });
    const other = fake('FakeScans', {
      results: HIT,
      chapters: [{ id: 'as-1', title: 'Chapter 1', isLocked: true, unlockTime: '2026-08-15T00:05:48Z' }],
    });
    const agg = new MangaAggregator({
      providers: [dex, other],
      metadata: meta(),
      bridges: bridgeFor('FakeDex', 'md-uuid'),
    });

    const { out } = await capture(() => agg.getChapters(105398));

    assert.equal(out.provider, 'FakeDex', 'the HIGHEST-CONFIDENCE unreadable list is the one held');
    assert.equal(out.providerId, 'md-uuid');
    assert.equal(out.matchConfidence, 'exact-id', 'the confidence label is not downgraded by unreadability');
    assert.equal(out.via, 'mangadex-links.al');
    assert.equal(out.chapters.length, 24, 'the full list survives — nothing is filtered out');
    assert.equal(out.chapters[0].unavailable.reason, 'external');
    assert.match(
      out.chapters[0].unavailable.detail,
      /webnovel\.com/,
      'the off-site URL is the actionable part — a client links out with it'
    );
    // ... and it is LABELLED, so this is not mistaken for a working list.
    assert.equal(typeof out.reason, 'string');
    assert.match(out.reason, /NOT READABLE/);
    assert.match(out.reason, /external/);
    // The machine-readable form of the same fact, which is what a client should actually branch on.
    assert.ok(out.chapters.every(c => c.unavailable), 'every chapter carries its own marker');
  });

  test('5. an all-unavailable list beats an empty one — it is strictly more information', async () => {
    // Ordering trap: the empty-list provider is walked FIRST here (equal confidence, earlier in the
    // registry). Falling out to `{ provider: null, chapters: [], reason }` because "the last thing
    // tried had nothing" would throw away the only real chapter list in the call.
    const blank = fake('FakeBlank', { results: HIT, chapters: [] });
    const dex = fake('FakeDex', { results: HIT, chapters: allExternal(3) });
    const agg = new MangaAggregator({ providers: [blank, dex], metadata: meta() });

    const { out } = await capture(() => agg.getChapters(105398));
    assert.equal(out.provider, 'FakeDex');
    assert.equal(out.chapters.length, 3);
    assert.match(out.reason, /NOT READABLE/);
  });

  test('6. GAPS are served, not demoted: one readable chapter is enough to admit a provider', async () => {
    // Zero readable is a boolean, not a threshold. A percentage rule here would demote a
    // legitimately mostly-licensed series, and the gaps are already MARKED for the caller.
    const dex = fake('FakeDex', {
      results: HIT,
      chapters: [
        ...allExternal(23),
        { id: 'md-24', title: 'Chapter 24', chapterNumber: '24' }, // the single readable one
      ],
    });
    const scan = fake('FakeScans', { results: HIT, chapters: readableChapters('as', 200) });
    const agg = new MangaAggregator({
      providers: [dex, scan],
      metadata: meta(),
      bridges: bridgeFor('FakeDex', 'md-uuid'),
    });

    const { out } = await capture(() => agg.getChapters(105398));
    assert.equal(out.provider, 'FakeDex', '1 readable chapter out of 24 still admits the provider');
    assert.equal(out.chapters.length, 24, 'the unreadable 23 are MARKED, never dropped');
    assert.equal(out.chapters.filter(c => c.unavailable).length, 23);
    assert.equal(out.reason, undefined, 'a list with gaps is an ordinary success, not a degraded one');
    assert.ok(!scan.parser.calls.includes('info:sl-1'), 'and the fall-through must not have fired');
  });

  test('7. an ordinary success is byte-for-byte the envelope it always was', async () => {
    // The policy must be invisible to every caller it does not rescue. If `reason` started
    // appearing on normal answers, every client that treats a present `reason` as "no match" would
    // break on a perfectly good chapter list.
    const only = fake('FakeScans', { results: HIT, chapters: readableChapters('as', 2) });
    const agg = new MangaAggregator({ providers: [only], metadata: meta() });
    const { out } = await capture(() => agg.getChapters(105398));
    assert.deepEqual(Object.keys(out).sort(), ['chapters', 'lang', 'matchConfidence', 'provider', 'providerId']);
    assert.equal(out.provider, 'FakeScans');
    assert.equal(out.matchConfidence, 'unverified');
    assert.equal(out.lang, 'en');
  });

  test('8. an explicit ?provider= is a PREFERENCE and the filter applies to it identically', async () => {
    // `opts.provider` has always been a preference rather than a pin: getChapters already falls
    // through it when it throws or returns an empty list. Exempting it from the servability filter
    // alone would mean `?provider=MangaDex` behaves differently from the default path for no
    // statable reason — and the caller who named it wants to READ, not to be told they picked
    // right. It is still tried FIRST, and it is still what comes back if nothing else can serve.
    const trace = [];
    const dex = fake('FakeDex', { results: HIT, chapters: allExternal(24), trace });
    const scan = fake('FakeScans', { results: HIT, chapters: readableChapters('as', 200), trace });
    const agg = new MangaAggregator({ providers: [scan, dex], metadata: meta() });

    const { out } = await capture(() => agg.getChapters(105398, { provider: 'fakedex' }));
    assert.deepEqual(trace, ['FakeDex', 'FakeScans'], 'the named provider is tried FIRST, ahead of registry order');
    assert.equal(out.provider, 'FakeScans', 'and fallen through when it can serve nothing, as for an empty list');

    // ...and with no alternative, the named provider is exactly what comes back, marked.
    const alone = new MangaAggregator({ providers: [fake('FakeDex', { results: HIT, chapters: allExternal(24) })], metadata: meta() });
    const { out: pinned } = await capture(() => alone.getChapters(105398, { provider: 'fakedex' }));
    assert.equal(pinned.provider, 'FakeDex');
    assert.match(pinned.reason, /NOT READABLE/);
  });
});
