// Provider constructors must forward (proxy, adapter) to the base Proxy — and do it exactly once.
//
// WHAT THIS PROTECTS. Every anime provider used to open with `super(...arguments)`. `arguments` is
// the DERIVED 3-arg list `(customBaseURL, proxy, adapter)`, but `Proxy`'s constructor takes
// `(proxyConfig, adapter)` — so every argument shifted one slot left and the third was dropped by
// `super` entirely. `...arguments` is typed `any[]`, so `tsc` could not see it. The derived body
// then repaired the provider's OWN client with `setProxy`/`setAxiosAdapter`, which is exactly why
// this survived: `this.client` looked right while `this.proxyConfig`/`this.adapter` did not.
//
// Two things broke, and each has a test below:
//
//  1. `this.adapter` stayed undefined, so the five providers that build extractors as
//     `new X(this.proxyConfig, this.adapter)` — gogoanime, anikototv, anineko, animenosub,
//     reanime — handed their extractors NOTHING. A test that faked every byte of transport still
//     opened a real socket the moment an extractor ran. Before the fix, test 1 here dies with
//     `getaddrinfo ENOTFOUND` and an EMPTY `seen` array.
//
//  2. The 2-arg call `new Provider(customBaseURL, proxyConfig)` put the ProxyConfig OBJECT into
//     the adapter slot, making `client.defaults.adapter` a non-function: every request then threw
//     `TypeError: adapter is not a function`. `src/providers/meta/anilist.ts` does exactly
//     `new Gogoanime(customBaseURL, proxyConfig)` — a loaded gun with the safety on. Test 2 pins it.
//
// And the trap in the fix itself: changing `super(...arguments)` to `super(proxy, adapter)` while
// LEAVING the old `if (proxy) this.setProxy(proxy)` body makes setProxy run TWICE, installing two
// request interceptors, so the dispatched URL comes out double-prefixed
// (`https://proxy.test/https://proxy.test/https://target.test/x`). Test 3 pins that.
//
// STILL OPEN, deliberately out of scope here: mkissa builds its extractors as
// `make: () => new StreamWish()` (mkissa.ts:183-190) with NO arguments, so mkissa's extractors
// cannot receive a fake adapter even now that its constructor forwards correctly. That is a
// behaviour change to a live provider and wants its own commit and test.
//
// Runs against dist/ — build first. A stale dist fails these for the obvious reason:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BASE = '../dist/providers/anime';
const EXT = '.js';
const load = name => {
  const m = require(`${BASE}/${name}${EXT}`);
  return m.default ?? m;
};

const AnikotoTV = load('anikototv');
const Gogoanime = load('gogoanime');

/** every provider whose constructor was fixed — all twelve had the identical broken body */
const ALL_PROVIDERS = [
  'anidb',
  'anikototv',
  'animenosub',
  'animepahe',
  'anineko',
  'anizone',
  'gogoanime',
  'kaa',
  'mkissa',
  'reanime',
  'senshi',
  'uniquestream',
];

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nv1080.m3u8\n';

/**
 * axios adapter over a {url-substring → body} map. Anything unmatched REJECTS — so if a request
 * escapes to the real network instead of coming through here, the test cannot silently pass.
 * `seen` records every request the adapter actually served.
 */
const fakeAdapter = routes => {
  const seen = [];
  const adapter = async config => {
    const qs = config.params ? `?${new URLSearchParams(config.params)}` : '';
    const url = `${config.url}${qs}`;
    seen.push(url);
    const hit = Object.keys(routes)
      .filter(k => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (hit === undefined) throw new Error(`ECONNREFUSED ${url}`);
    return { data: routes[hit], status: 200, statusText: 'OK', headers: {}, config };
  };
  adapter.seen = seen;
  return adapter;
};

/** an embed host that speaks the megaplay protocol (data-id → /stream/getSources) */
const megaplayProtocolHost = origin => ({
  [`${origin}/stream/`]: `<html><body><div id="player" data-id="99"></div></body></html>`,
  [`${origin}/stream/getSources?id=99`]: {
    sources: { file: 'https://cdn.example/master.m3u8' },
    tracks: [{ file: 'https://cdn.example/en.vtt', label: 'English', kind: 'captions' }],
    intro: { start: 0, end: 0 },
    outro: { start: 0, end: 0 },
  },
  'https://cdn.example/master.m3u8': MASTER,
});

describe('the constructor forwards its adapter all the way to the extractors it builds', () => {
  test('an adapter passed as the DOCUMENTED 3rd argument serves the extractor, with no real socket', async () => {
    // The whole point: construct through the public API only. No `p.adapter = ...` by hand — that
    // hand-assignment was the workaround that hid this bug, so doing it here would test nothing.
    const adapter = fakeAdapter(megaplayProtocolHost('https://only-the-fake-serves-this.example'));
    const p = new AnikotoTV(undefined, undefined, adapter);

    // sanity: the forwarding is what is under test, so assert the field itself too
    assert.equal(p.adapter, adapter, '`this.adapter` must hold the constructor 3rd argument');

    const src = await p['extractEmbed']('https://only-the-fake-serves-this.example/stream/s-2/128368/sub');

    assert.equal(src.sources[0].url, 'https://cdn.example/master.m3u8');
    assert.equal(src.subtitles[0].lang, 'English');
    // Before the fix this array was EMPTY and the call died with getaddrinfo ENOTFOUND: the
    // extractor built its own client with no adapter and went to real DNS.
    assert.ok(
      adapter.seen.length > 0,
      'the extractor bypassed the fake transport entirely — it went to the real network'
    );
    assert.ok(
      adapter.seen.some(u => u.includes('/stream/getSources')),
      `the extractor never spoke the megaplay protocol over the fake transport, saw: ${adapter.seen.join(', ')}`
    );
  });

  test('the same holds for gogoanime, the provider anilist actually constructs', async () => {
    const adapter = fakeAdapter(megaplayProtocolHost('https://megaplay.buzz'));
    const p = new Gogoanime(undefined, undefined, adapter);
    assert.equal(p.adapter, adapter);
    assert.equal(p.client.defaults.adapter, adapter);
  });
});

describe('a 2-arg construction must not land the ProxyConfig in the adapter slot', () => {
  // src/providers/meta/anilist.ts does `new Gogoanime(customBaseURL, proxyConfig)`. With
  // `super(...arguments)` that object became `client.defaults.adapter`, and every subsequent
  // request threw `TypeError: adapter is not a function`.
  test('client.defaults.adapter stays a function (or undefined) — never the config object', () => {
    const proxyConfig = { url: 'https://proxy.test/' };
    const p = new Gogoanime(undefined, proxyConfig);

    const a = p.client.defaults.adapter;
    assert.ok(
      a === undefined || typeof a === 'function' || typeof a === 'string' || Array.isArray(a),
      `client.defaults.adapter must be dispatchable by axios, got ${typeof a}: ${JSON.stringify(a)}`
    );
    assert.notDeepEqual(a, proxyConfig, 'the ProxyConfig object leaked into the adapter slot');
    assert.equal(p.proxyConfig, proxyConfig, 'the ProxyConfig belongs in the proxyConfig slot');
  });

  // All twelve shared one copy-pasted constructor, so all twelve are pinned here — the two
  // suites above only exercise anikototv and gogoanime, and a partial revert of the other ten
  // is exactly the state this whole change exists to prevent.
  for (const name of ALL_PROVIDERS) {
    test(`${name}: all three arguments land in their own slot`, () => {
      const Provider = load(name);
      const proxyConfig = { url: 'https://proxy.test/' };
      const adapter = async config => ({ data: '', status: 200, statusText: 'OK', headers: {}, config });

      const p = new Provider('custom.example', proxyConfig, adapter);

      assert.equal(p.baseUrl, 'https://custom.example', 'customBaseURL must reach baseUrl');
      assert.equal(p.proxyConfig, proxyConfig, 'the ProxyConfig must reach the proxyConfig slot');
      assert.equal(p.adapter, adapter, 'the adapter must reach the adapter slot');
      assert.equal(p.client.defaults.adapter, adapter, 'the adapter must reach the client');
      // the trap: forwarding to super() while KEEPING the old `if (proxy) this.setProxy(proxy)`
      // body installs the interceptor twice and double-prefixes every url
      const handlers = p.client.interceptors.request.handlers.filter(Boolean);
      assert.equal(handlers.length, 1, `expected 1 request interceptor, found ${handlers.length}`);
    });
  }
});

describe('the proxy interceptor is installed exactly once', () => {
  // The trap in this fix. Forwarding to `super(proxy, adapter)` while keeping the old
  // `if (proxy) this.setProxy(proxy)` line runs setProxy twice → two request interceptors → the
  // proxy prefix applied twice.
  test('the dispatched url carries the proxy prefix once, not twice', async () => {
    const seen = [];
    const recorder = async config => {
      seen.push(config.url);
      return { data: 'ok', status: 200, statusText: 'OK', headers: {}, config };
    };
    const p = new Gogoanime(undefined, { url: 'https://proxy.test/' }, recorder);

    await p.client.get('https://target.test/x');

    assert.equal(seen.length, 1);
    assert.equal(
      seen[0],
      'https://proxy.test/https://target.test/x',
      'proxy prefix applied the wrong number of times — setProxy ran more than once'
    );
  });

  test('only one request interceptor handler exists', () => {
    const p = new Gogoanime(undefined, { url: 'https://proxy.test/' });
    const handlers = p.client.interceptors.request.handlers.filter(Boolean);
    assert.equal(handlers.length, 1, `expected 1 request interceptor, found ${handlers.length}`);
  });

  test('no proxy config means no interceptor at all', () => {
    const p = new Gogoanime();
    const handlers = p.client.interceptors.request.handlers.filter(Boolean);
    assert.equal(handlers.length, 0);
  });
});
