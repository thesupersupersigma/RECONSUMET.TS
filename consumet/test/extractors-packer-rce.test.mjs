// One RCE test per call site converted away from eval().
//
// unpack-packer.test.mjs proves the shared expander is correct and inert. This file proves each
// CALLER actually routes through it — that a hostile page fed to Kwik, MixDrop, StreamHub or
// mangahere fails loudly instead of executing. Each hostile fixture is first run through `oldSink`
// (the eval these files used to contain) to show it really is live code; without that, "nothing
// executed" would prove nothing.
//
// The upstream fetch is stubbed, so nothing here touches the network — these sites are third-party
// video/manga hosts and the point is what happens to their bytes, not whether they are up.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CANARY, oldSink, hostilePage, pack, buildPage } from './helpers/packer-fixtures.mjs';

const require = createRequire(import.meta.url);
const load = path => {
  const mod = require(path);
  return mod.default ?? mod;
};
const Kwik = load('../dist/extractors/kwik.js');
const MixDrop = load('../dist/extractors/mixdrop.js');
const StreamHub = load('../dist/extractors/streamhub.js');
const MangaHere = load('../dist/providers/manga/mangahere.js');

/** replace the axios instance so the "page" is ours and no request leaves the machine */
const withPage = (instance, page) => {
  instance.client = { get: async () => ({ data: page }) };
  return instance;
};

/** assert a fixture is genuinely executable under the old sink, then clear the canary */
const assertHostile = page => {
  oldSink(page);
  assert.equal(globalThis[CANARY], 'pwned', 'fixture is not actually hostile — the assertion below would prove nothing');
  delete globalThis[CANARY];
};

afterEach(() => {
  delete globalThis[CANARY];
});

describe('converted call sites do not execute page-supplied code', () => {
  test('Kwik extractor', async () => {
    // returns what Kwik's own parsing wants (an m3u8), so the compromise would have looked normal
    const page = hostilePage(`const s="https://vault-1.uwucdn.top/a/b.m3u8"`);
    assertHostile(page);

    const kwik = withPage(new Kwik(), page);
    await assert.rejects(kwik.extract(new URL('https://kwik.cx/e/HOSTILE')), /no P\.A\.C\.K\.E\.R script found/);
    assert.equal(globalThis[CANARY], undefined);
  });

  test('MixDrop extractor', async () => {
    const page = hostilePage(`poster="//img.example/p.jpg" wurl="//cdn.example/v.mp4"`);
    assertHostile(page);

    const mixdrop = withPage(new MixDrop(), page);
    await assert.rejects(mixdrop.extract(new URL('https://mixdrop.co/e/HOSTILE')), /no P\.A\.C\.K\.E\.R script found/);
    assert.equal(globalThis[CANARY], undefined);
  });

  test('StreamHub extractor', async () => {
    const page = hostilePage(`sources:[{src:"https://cdn.example/master.m3u8"}]`);
    assertHostile(page);

    const streamhub = withPage(new StreamHub(), page);
    await assert.rejects(
      streamhub.extract(new URL('https://streamhub.to/e/HOSTILE')),
      /no P\.A\.C\.K\.E\.R script found/
    );
    assert.equal(globalThis[CANARY], undefined);
  });

  test('mangahere chapter pages', async () => {
    // the `script[src*=chapter_bar]` tag is what sends this provider down the packed-script branch
    const page = hostilePage(`['//zjcdn.example/p1.jpg','//zjcdn.example/p2.jpg']`).replace(
      '<body>',
      '<body><script src="/chapter_bar.js"></script>'
    );
    assertHostile(page);

    const mangahere = withPage(new MangaHere(), page);
    await assert.rejects(mangahere.fetchChapterPages('naruto/c001'), /no P\.A\.C\.K\.E\.R script found/);
    assert.equal(globalThis[CANARY], undefined);
  });
});

describe('converted call sites still read a legitimate packed page', () => {
  // Guards the other direction: the conversions must not have broken extraction. Each page is a
  // real packer call whose unpacked source is that extractor's expected shape.
  test('Kwik finds the stream url', async () => {
    const page = buildPage(pack(`var s='https://vault-9.uwucdn.top/x/y/uwu.m3u8';`, 36));
    const sources = await withPage(new Kwik(), page).extract(new URL('https://kwik.cx/e/OK'));
    assert.equal(sources[0].url, 'https://vault-9.uwucdn.top/x/y/uwu.m3u8');
    assert.equal(sources[0].isM3U8, true);
  });

  test('MixDrop finds poster and stream url', async () => {
    const page = buildPage(pack(`poster="//img.example/p.jpg" wurl="//cdn.example/v.mp4"`, 36));
    const sources = await withPage(new MixDrop(), page).extract(new URL('https://mixdrop.co/e/OK'));
    assert.equal(sources[0].poster, 'https://img.example/p.jpg');
    assert.equal(sources[0].url, 'https://cdn.example/v.mp4');
  });

  test('mangahere reads its page list', async () => {
    const page = buildPage(pack(`var pix=['//zjcdn.example/p1.jpg','//zjcdn.example/p2.jpg'];`, 36)).replace(
      '<body>',
      '<body><script src="/chapter_bar.js"></script>'
    );
    const pages = await withPage(new MangaHere(), page).fetchChapterPages('naruto/c001');
    assert.deepEqual(
      pages.map(p => p.img),
      ['https://zjcdn.example/p1.jpg', 'https://zjcdn.example/p2.jpg']
    );
  });
});
