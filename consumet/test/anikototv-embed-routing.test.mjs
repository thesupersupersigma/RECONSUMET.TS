// AnikotoTV embed routing — the host-rename failure mode.
//
// WHAT THIS PROTECTS. AniNeko pinned the literal host `vibeplayer.site`. The host renamed itself to
// `vivibebe.site`, the match stopped firing, and the provider "mysteriously returned nothing" until
// someone traced it by hand. AnikotoTV's router had the same shape, and was already losing a server
// to it: `VidPlay-1` resolves to `vidtube.site`, which the router did not know, so it was dropped on
// every request (confirmed live before the fix — 2 of 3 servers returned).
//
// The router now recognises known hosts, then falls back to trying the embed SHAPES it knows, and
// only then fails — loudly. These tests pin all three behaviours.
//
// Offline: every HTTP call is served by a fake axios adapter, which the provider constructor
// forwards to the extractors it builds, so the real wiring is exercised without the network.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/anime/anikototv.js');
const AnikotoTV = mod.default ?? mod;

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nv1080.m3u8\n';

/**
 * axios adapter over a {url-substring → body} map. Anything unmatched rejects, the way a dead or
 * renamed host actually behaves. `seen` records every request so tests can assert what was probed.
 */
const fakeAdapter = routes => {
  const seen = [];
  const adapter = async config => {
    const qs = config.params ? `?${new URLSearchParams(config.params)}` : '';
    const url = `${config.url}${qs}`;
    seen.push(url);
    // longest match wins, so `/stream/getSources?id=99` beats the `/stream/` embed-page entry
    const hit = Object.keys(routes)
      .filter(k => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (hit === undefined) throw new Error(`ECONNREFUSED ${url}`);
    const data = routes[hit];
    return { data, status: 200, statusText: 'OK', headers: {}, config };
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

// NOTE: the constructor's 3rd parameter does NOT reach the extractors — every provider here does
// `super(...arguments)`, and the base Proxy constructor only takes (proxyConfig, adapter), so the
// adapter lands in `this.proxyConfig`'s slot and `this.adapter` stays undefined. Set both fields
// directly instead, so the extractors the provider builds really do run on the fake transport.
const provider = adapter => {
  const p = new AnikotoTV();
  p.client.defaults.adapter = adapter; // the provider's own /ajax calls
  p.adapter = adapter; // forwarded into `new MegaPlay(...)` / `new VibePlayer(...)`
  return p;
};
const route = (adapter, embed) => provider(adapter)['extractEmbed'](embed);

describe('AnikotoTV routes an embed by shape, not by pinned host name', () => {
  test('a KNOWN host still routes exactly as before', async () => {
    const adapter = fakeAdapter(megaplayProtocolHost('https://megaplay.buzz'));
    const src = await route(adapter, 'https://megaplay.buzz/stream/s-2/128368/sub');
    assert.equal(src.sources[0].url, 'https://cdn.example/master.m3u8');
    assert.equal(src.subtitles[0].lang, 'English');
  });

  test('an UNKNOWN host that speaks the megaplay protocol is read anyway', async () => {
    // This is the live vidtube.site case: same protocol, host the router had never heard of.
    const adapter = fakeAdapter(megaplayProtocolHost('https://brand-new-host.example'));
    const src = await route(adapter, 'https://brand-new-host.example/stream/SklLc1A1/sub');
    assert.equal(src.sources[0].url, 'https://cdn.example/master.m3u8');
    assert.equal(src.subtitles.length, 1);
  });

  test('the renamed vibeplayer host (vivibebe) routes to the generic embed reader', async () => {
    const adapter = fakeAdapter({
      'https://vivibebe.site/abc123': `<html><script>file:"https://vivibebe.site/public/stream/abc123/master.m3u8"</script></html>`,
      'https://vivibebe.site/public/stream/abc123/master.m3u8': MASTER,
    });
    const src = await route(adapter, 'https://vivibebe.site/abc123');
    assert.equal(src.sources[0].url, 'https://vivibebe.site/public/stream/abc123/master.m3u8');
  });

  test('an unknown host with no protocol at all is still read if the page carries an m3u8', async () => {
    const adapter = fakeAdapter({
      'https://who.example/e/xyz': `<html><body><video data-src="https://cdn.example/master.m3u8"></video></body></html>`,
      'https://cdn.example/master.m3u8': MASTER,
    });
    const src = await route(adapter, 'https://who.example/e/xyz');
    assert.equal(src.sources[0].url, 'https://cdn.example/master.m3u8');
  });

  test('a wrapped plyr.php embed is unwrapped before routing', async () => {
    const inner = Buffer.from('https://brand-new-host.example/stream/AAA/sub').toString('base64');
    const adapter = fakeAdapter(megaplayProtocolHost('https://brand-new-host.example'));
    const src = await route(adapter, `https://mewcdn.online/player/plyr.php#${inner}#`);
    assert.equal(src.sources[0].url, 'https://cdn.example/master.m3u8');
  });

  test('a direct .m3u8 embed passes through with the host as Referer', async () => {
    const src = await route(fakeAdapter({}), 'https://cdn.example/direct/master.m3u8');
    assert.equal(src.sources[0].url, 'https://cdn.example/direct/master.m3u8');
    assert.equal(src.headers.Referer, 'https://cdn.example/');
  });
});

describe('AnikotoTV fails loudly when no reader can handle the host', () => {
  const deadHost = () =>
    fakeAdapter({ 'https://renamed-and-broken.example/e/1': '<html><body>nothing useful here</body></html>' });

  test('the error names the host, the url, the rename hypothesis and every attempt', async () => {
    const adapter = deadHost();
    await assert.rejects(route(adapter, 'https://renamed-and-broken.example/e/1'), err => {
      assert.match(err.message, /renamed-and-broken\.example/, 'must name the host');
      assert.match(err.message, /https:\/\/renamed-and-broken\.example\/e\/1/, 'must name the url');
      assert.match(err.message, /host rename/i, 'must point at the likely cause');
      assert.match(err.message, /megaplay-protocol:/, 'must say what was tried');
      assert.match(err.message, /generic-embed:/, 'must say what was tried');
      return true;
    });
    // and it genuinely probed both shapes before giving up
    assert.ok(
      adapter.seen.some(u => u.includes('/e/1')),
      `expected the embed to be fetched, saw: ${adapter.seen.join(', ')}`
    );
  });

  test('an unusable embed value is rejected with its actual content, not a generic message', async () => {
    for (const bad of ['', 'not-a-url', '/relative/only']) {
      await assert.rejects(route(fakeAdapter({}), bad), /embed is not a usable url/, JSON.stringify(bad));
    }
  });

  test('a single-server episode whose host renamed FAILS rather than returning an empty list', async () => {
    // The per-server catch in fetchEpisodeSourcesAll is deliberate (one dead server must not sink
    // the others), so the loudness that matters is: nothing resolvable → throw, never `[]`.
    const adapter = fakeAdapter({
      'https://anikototv.to/ajax/episode/list/4': { result: `<a data-num="1" data-ids="BLOB"></a>` },
      'https://anikototv.to/ajax/server/list?servers=BLOB': {
        result: `<div class="type" data-type="sub"><ul><li data-link-id="L1">VidPlay-1</li></ul></div>`,
      },
      'https://anikototv.to/ajax/server?get=L1': { result: { url: 'https://renamed-and-broken.example/e/1' } },
      'https://renamed-and-broken.example/e/1': '<html><body>nothing useful here</body></html>',
    });

    const warnings = [];
    const realWarn = console.warn;
    console.warn = msg => warnings.push(String(msg));
    try {
      await assert.rejects(provider(adapter).fetchEpisodeSourcesAll('4/1', 'sub'), /all servers failed to resolve/);
    } finally {
      console.warn = realWarn;
    }
    // the per-server log has to carry the diagnosis, or the rename is invisible in production
    assert.ok(
      warnings.some(w => /VidPlay-1/.test(w) && /renamed-and-broken\.example/.test(w) && /host rename/i.test(w)),
      `per-server warning lost the diagnosis: ${JSON.stringify(warnings)}`
    );
  });
});
