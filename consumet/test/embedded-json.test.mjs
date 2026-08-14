// The shared embedded-JSON extractor (src/utils/embedded-json.ts).
//
// WHAT THIS PROTECTS. Four rewrite-tier manga providers — AsuraScans (Astro v5 island props),
// FlameComics (Next.js __NEXT_DATA__), and the ld+json / inline-assignment sites — all have the
// same shape: the HTML is a shell and the real data is embedded JSON. They share one extractor
// instead of four hand-rolled cheerio blocks, so a defect here is a defect in all of them at once.
// Two properties have to hold:
//
//   1. It NEVER answers `undefined`. The providers this repo is deleting failed open — a selector
//      stopped matching, `undefined` came back, and the API reported "no chapters" for months. Here
//      an absence and a corruption are two different, loud, distinguishable errors:
//        reason 'not-found'    — nothing of that shape on the page
//        reason 'unparseable'  — something was, and it could not be read
//      Conflating them is how you spend a day hunting a format change that never happened.
//   2. It executes NOTHING. It parses bytes chosen by a scanlation site. `eval`/`new Function` on
//      remote text is the bug test/extractors-packer-rce.test.mjs was written for; the hostile
//      fixtures below are that suite's method applied to this parser. Each is first run through
//      `oldSink` — `new Function('return (' + text + ')')`, which is genuinely how people "read"
//      a `window.__DATA__ = {…}` blob that JSON.parse rejects — to prove it really is live code.
//      Without that, "nothing executed" would prove nothing.
//
// Fully offline: every input is a fixture string in this file, shaped from real pages fetched on
// 2026-08-14 (asurascans.com chapter island, flamecomics.xyz __NEXT_DATA__, mangapark.cc ld+json,
// weebcentral.com — which has no embedded JSON at all and must therefore come back 'not-found').
// Nothing here touches the network; the point is what happens to a site's bytes, not whether it
// is up.
//
// Runs against dist/ — the artifact the API loads — so build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { extractEmbeddedJson, findEmbeddedJson, decodeAstroProps, EmbeddedJsonError, EMBEDDED_JSON_SHAPES } =
  require('../dist/utils/embedded-json.js');

assert.equal(typeof extractEmbeddedJson, 'function', 'dist/ is missing extractEmbeddedJson — rebuild it first');

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** set by the hostile fixtures below if page-supplied code ever runs */
const CANARY = '__EMBEDDED_JSON_RCE_CANARY__';

/**
 * The sink a lazy implementation reaches for when JSON.parse refuses a `window.__X__ = {…}` blob:
 * the payload is JS object syntax, so "just eval it". The site chooses that text completely, so it
 * runs whatever it likes with this process's privileges. Used only to prove a fixture is live.
 */
const oldSink = text => new Function(`return (${text})`)();

const htmlEscapeAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** an <astro-island> the way Astro v5 emits one: props JSON, entity-escaped, in an attribute */
const astroIsland = (props, component = '/_astro/ChapterReader.B6AYUpQi.js') =>
  `<astro-island uid="ZSYGQt" prefix="r1" component-url="${component}" component-export="default" ` +
  `renderer-url="/_astro/client.js" props="${htmlEscapeAttr(JSON.stringify(props))}" ssr client="load"></astro-island>`;

/** Next.js escapes `<` as \u003c inside __NEXT_DATA__, which is why a real one never truncates */
const nextData = json =>
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(json).replace(/</g, '\\u003c')}</script>`;

const page = body => `<!DOCTYPE html><html><head><title>x</title></head><body>${body}</body></html>`;

/** asurascans.com/comics/breakers-7e1f454a/chapter/105, trimmed to the fields that matter */
const ASURA_PROPS = {
  seriesSlug: [0, 'breakers-7e1f454a'],
  seriesName: [0, 'Breakers'],
  chapterId: [0, 260772],
  chapterName: [0, '105'],
  chapterTitle: [0], // Astro's `undefined` — a one-element tuple
  pages: [
    1,
    [
      [0, { url: [0, 'https://cdn.asurascans.com/asura-images/chapters/breakers/105/861323.webp'], width: [0, 1200] }],
      [0, { url: [0, 'https://cdn.asurascans.com/asura-images/chapters/breakers/105/861324.webp'], width: [0, 1200] }],
    ],
  ],
  nextChapter: [0, null],
  chapterList: [1, [[0, { id: [0, 260772], number: [0, 105], slug: [0, 'chapter-105'] }]]],
};

/** flamecomics.xyz/series/104/<token>, trimmed */
const FLAME_NEXT = {
  props: {
    pageProps: {
      chapter: {
        series_id: 104,
        chapter: '193.00',
        title: 'Tyrant of the Tower Defense Game',
        images: {
          0: { name: 'TTDG-193-00.webp', width: 1778, height: 1000 },
          1: { name: 'TTDG-193-01.webp', width: 800, height: 13147 },
        },
      },
      token: '35df6aade4b42d3c',
    },
  },
  page: '/series/[id]/[token]',
  buildId: 'abc123',
};

/** mangapark.cc/read/area-88/en/chapter-1 — two ld+json blocks and nothing else */
const MANGAPARK_PAGE = page(
  `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'Area 88 Chapter 1',
    image: 'https://c.imgeu2.lol/chapter/840a1474/1-0ef4694e.jpg',
  })}</script>
   <script type="application/ld+json">${JSON.stringify({
     '@context': 'https://schema.org',
     '@type': 'BreadcrumbList',
     itemListElement: [{ '@type': 'ListItem', position: 3, name: 'Chapter 1' }],
   })}</script>
   <script>window.dataLayer = window.dataLayer || [];</script>`
);

/** weebcentral.com/chapters/<ulid> — server-rendered HTML + htmx, no embedded JSON anywhere. The
 *  `var readingStylesWithPage = ['single_page', …]` is real: valid JS, not JSON, and a trap for a
 *  scanner that reports every failed guess as a corruption. */
const WEEBCENTRAL_PAGE = page(
  `<section id="chapter-images"><img src="https://official.lowee.us/manga/x/0001-001.png" alt="Page 1"></section>
   <script>var readingStylesWithPage = ['single_page', 'double_page'];</script>
   <script defer src="/static/js/script.min.js"></script>`
);

const reasonOf = fn => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof EmbeddedJsonError, `expected an EmbeddedJsonError, got ${err}`);
    return err;
  }
  return assert.fail('expected a throw, got a value');
};

afterEach(() => {
  delete globalThis[CANARY];
});

/* ------------------------------------------------------------------ *
 * each supported shape, against the real pages' layouts
 * ------------------------------------------------------------------ */

describe('extractEmbeddedJson — the shapes the rewrite-tier providers need', () => {
  test('Next.js __NEXT_DATA__ (FlameComics)', () => {
    const data = extractEmbeddedJson(page(nextData(FLAME_NEXT)), {
      shapes: ['next-data'],
      source: 'https://flamecomics.xyz/series/104/35df6aade4b42d3c',
    });
    assert.deepEqual(data, FLAME_NEXT);
    assert.equal(Object.keys(data.props.pageProps.chapter.images).length, 2);
    assert.equal(data.props.pageProps.chapter.images[1].name, 'TTDG-193-01.webp');
  });

  test('Astro island props (AsuraScans) — entity-decoded AND tuple-decoded', () => {
    const props = extractEmbeddedJson(page(astroIsland(ASURA_PROPS)), {
      shapes: ['astro-props'],
      source: 'https://asurascans.com/comics/breakers-7e1f454a/chapter/105',
    });
    // the caller must never see Astro's [typeCode, value] wire form
    assert.equal(props.seriesName, 'Breakers');
    assert.equal(props.chapterId, 260772);
    assert.equal(props.chapterTitle, undefined);
    assert.equal(props.nextChapter, null);
    assert.deepEqual(
      props.pages.map(p => p.url),
      [
        'https://cdn.asurascans.com/asura-images/chapters/breakers/105/861323.webp',
        'https://cdn.asurascans.com/asura-images/chapters/breakers/105/861324.webp',
      ]
    );
    assert.equal(props.pages[0].width, 1200);
    assert.equal(props.chapterList[0].slug, 'chapter-105');
  });

  test('picks the right island out of many, by locator', () => {
    const html = page(
      astroIsland({ isNovelHome: [0, false] }, '/_astro/MobileModeToggle.js') +
        astroIsland({ items: [1, []] }, '/_astro/Header.js') +
        astroIsland(ASURA_PROPS, '/_astro/ChapterReader.B6AYUpQi.js')
    );
    const props = extractEmbeddedJson(html, { shapes: ['astro-props'], locator: /ChapterReader/ });
    assert.equal(props.seriesName, 'Breakers');

    // and without a filter, all three are readable in document order
    const all = findEmbeddedJson(html, { shapes: ['astro-props'] });
    assert.equal(all.length, 3);
    assert.deepEqual(
      all.map(h => h.shape),
      ['astro-props', 'astro-props', 'astro-props']
    );
    assert.match(all[0].locator, /MobileModeToggle/);
  });

  test('a /g/ locator regexp does not skip every other candidate', () => {
    // RegExp.test on a global regexp advances lastIndex; reusing the caller's object across
    // candidates would match, then miss, then match. The filter must be stateless.
    const html = page(astroIsland({ a: [0, 1] }, '/x/Reader.js') + astroIsland({ b: [0, 2] }, '/y/Reader.js'));
    const want = /Reader/g;
    assert.equal(findEmbeddedJson(html, { shapes: ['astro-props'], locator: want }).length, 2);
    assert.equal(findEmbeddedJson(html, { shapes: ['astro-props'], locator: want }).length, 2);
  });

  test('schema.org ld+json, selected with `where` (MangaPark)', () => {
    const crumbs = extractEmbeddedJson(MANGAPARK_PAGE, {
      shapes: ['ld+json'],
      where: d => d && d['@type'] === 'BreadcrumbList',
      source: 'https://mangapark.cc/read/area-88/en/chapter-1',
    });
    assert.equal(crumbs.itemListElement[0].name, 'Chapter 1');

    const both = findEmbeddedJson(MANGAPARK_PAGE, { shapes: ['ld+json'] });
    assert.deepEqual(
      both.map(h => h.data['@type']),
      ['Article', 'BreadcrumbList']
    );
    assert.equal(both[0].locator, 'script[type="application/ld+json"][0]');
  });

  test('plain <script type="application/json">, and __NEXT_DATA__ is not counted twice', () => {
    const html = page(nextData({ a: 1 }) + '<script id="cfg" type="application/json">{"b":2}</script>');
    assert.deepEqual(extractEmbeddedJson(html, { shapes: ['json-script'] }), { b: 2 });
    assert.deepEqual(extractEmbeddedJson(html, { shapes: ['next-data'] }), { a: 1 });
    // the default sweep sees each blob exactly once
    const all = findEmbeddedJson(html);
    assert.deepEqual(
      all.map(h => h.shape),
      ['next-data', 'json-script']
    );
  });

  test('window.__X__ = {…} in an inline script, without a fragile regexp', () => {
    const html = page(`<script>
      window.dataLayer = window.dataLayer || [];
      var CurChapter = {"Chapter":"100150","Page":"18"};
      self.__PRELOAD__ = [1,2,3];
      globalThis.__STATE__ = {"note":"a } inside a string, and a \\" escaped quote","ok":true};
    </script>`);
    const hits = findEmbeddedJson(html, { shapes: ['global-assign'] });
    assert.deepEqual(
      hits.map(h => h.locator),
      ['var CurChapter', 'self.__PRELOAD__', 'globalThis.__STATE__']
    );
    // the brace scanner must not stop at the `}` inside the string, nor at the escaped quote
    assert.equal(hits[2].data.note, 'a } inside a string, and a " escaped quote');
    assert.equal(hits[2].data.ok, true);
    assert.deepEqual(hits[1].data, [1, 2, 3]);
    // `window.dataLayer = window.dataLayer || []` is not an object literal and must not be claimed
    assert.equal(
      hits.some(h => h.locator === 'window.dataLayer'),
      false
    );
  });

  test('accepts an already-loaded CheerioAPI, so a provider need not parse the page twice', () => {
    const { load } = require('cheerio');
    const $ = load(page(nextData(FLAME_NEXT)));
    assert.equal(extractEmbeddedJson($, { shapes: ['next-data'] }).buildId, 'abc123');
  });

  test('findEmbeddedJson reports where each blob came from', () => {
    const [hit] = findEmbeddedJson(page(nextData({ a: 1 })), { shapes: ['next-data'] });
    assert.equal(hit.shape, 'next-data');
    assert.equal(hit.locator, 'script#__NEXT_DATA__');
    assert.deepEqual(hit.data, { a: 1 });
    assert.equal(hit.text, '{"a":1}');
  });
});

/* ------------------------------------------------------------------ *
 * entity-escaped payloads
 * ------------------------------------------------------------------ */

describe('HTML entity handling', () => {
  test('decodes &quot; &#39; &amp; &#x27; &#x22; in an Astro props attribute', () => {
    const raw =
      '{&quot;t&quot;:[0,&quot;it&#39;s &amp; more&quot;],' +
      '&quot;q&quot;:[0,&quot;he said \\&#x22;hi\\&#x22;&quot;],' +
      '&quot;apos&quot;:[0,&quot;&#x27;&quot;]}';
    const props = extractEmbeddedJson(page(`<astro-island component-url="/x.js" props="${raw}"></astro-island>`), {
      shapes: ['astro-props'],
    });
    assert.equal(props.t, "it's & more");
    assert.equal(props.q, 'he said "hi"');
    assert.equal(props.apos, "'");
  });

  test('a double-encoded entity survives as literal text, not decoded twice', () => {
    // `&amp;amp;` in the attribute is the string "&amp;" — decoding it a second time would silently
    // corrupt any URL carrying a query string.
    const props = extractEmbeddedJson(
      page('<astro-island component-url="/x.js" props="{&quot;u&quot;:[0,&quot;/a?b=1&amp;amp;c=2&quot;]}"></astro-island>'),
      { shapes: ['astro-props'] }
    );
    assert.equal(props.u, '/a?b=1&amp;c=2');
  });

  test('entities inside a <script> are NOT decoded — script content is raw text', () => {
    // If script bodies were entity-decoded, a JSON payload containing "&amp;" would come back as
    // "&", quietly changing every URL on the page.
    const html = page('<script id="__NEXT_DATA__" type="application/json">{"u":"/a?b=1&amp;c=2"}</script>');
    assert.equal(extractEmbeddedJson(html, { shapes: ['next-data'] }).u, '/a?b=1&amp;c=2');
  });
});

/* ------------------------------------------------------------------ *
 * </script> inside a string
 * ------------------------------------------------------------------ */

describe('a payload containing </script>', () => {
  test('the two escapings a real server emits both round-trip', () => {
    // Next.js writes \u003c; other stacks write <\/ (a legal JSON escape for "/")
    const unicode = page('<script id="__NEXT_DATA__" type="application/json">{"s":"a\\u003c/script>b"}</script>');
    const slashed = page('<script id="__NEXT_DATA__" type="application/json">{"s":"c<\\/script>d"}</script>');
    assert.equal(extractEmbeddedJson(unicode, { shapes: ['next-data'] }).s, 'a</script>b');
    assert.equal(extractEmbeddedJson(slashed, { shapes: ['next-data'] }).s, 'c</script>d');
  });

  test('an UNESCAPED </script> truncates the element — and that is reported, not returned', () => {
    // Per the HTML parsing spec the element ends at the first `</script`, so the JSON is cut in
    // half. A browser sees the same truncation. The one unacceptable outcome is handing back the
    // half-object as if it were the page's data.
    const html = page('<script id="__NEXT_DATA__" type="application/json">{"pages":["a.jpg","</script>"]}</script>');
    const err = reasonOf(() => extractEmbeddedJson(html, { shapes: ['next-data'], source: 'flame' }));
    assert.equal(err.reason, 'unparseable');
    assert.equal(err.locator, 'script#__NEXT_DATA__');
    assert.match(err.message, /flame/);
  });

  test('markup after the truncation cannot be spliced into the blob', () => {
    const html = page(
      '<script id="__NEXT_DATA__" type="application/json">{"pages":["</script>' +
        '<script id="x" type="application/json">{"pages":["https://attacker.example/1.jpg"]}</script>'
    );
    const hits = findEmbeddedJson(html, { shapes: ['json-script'] });
    assert.deepEqual(hits[0].data, { pages: ['https://attacker.example/1.jpg'] });
    // the truncated #__NEXT_DATA__ is a failure, never a merge of the two
    assert.throws(() => extractEmbeddedJson(html, { shapes: ['next-data'] }), EmbeddedJsonError);
  });
});

/* ------------------------------------------------------------------ *
 * malformed, absent, and the difference between them
 * ------------------------------------------------------------------ */

describe('fails loudly, and says WHICH fault it was', () => {
  const malformed = [
    ['trailing comma', page(nextData({ a: 1 }).replace('}', ',}'))],
    ['single quotes (JS, not JSON)', page(`<script id="__NEXT_DATA__" type="application/json">{'a':1}</script>`)],
    ['bare keys (JS object literal)', page('<script id="__NEXT_DATA__" type="application/json">{a:1}</script>')],
    ['truncated mid-response', page('<script id="__NEXT_DATA__" type="application/json">{"props":{"pageP')],
    ['not JSON at all', page('<script id="__NEXT_DATA__" type="application/json">Attention Required! | Cloudflare</script>')],
    [
      'astro props that are not JSON',
      page('<astro-island component-url="/x.js" props="{&quot;a&quot;:[0,}"></astro-island>'),
    ],
  ];

  for (const [name, html] of malformed) {
    test(`${name} → 'unparseable', naming the source`, () => {
      const err = reasonOf(() => extractEmbeddedJson(html, { source: 'https://example.test/ch/1' }));
      assert.equal(err.reason, 'unparseable', name);
      assert.match(err.message, /https:\/\/example\.test\/ch\/1/);
      assert.ok(err.locator, 'an unparseable blob must say where it was');
    });
  }

  const absent = [
    ['an empty response body', ''],
    ['a challenge interstitial', page('<h1>Attention Required!</h1><p>Please enable cookies.</p>')],
    ['a page whose only json script is empty', page('<script id="__NEXT_DATA__" type="application/json"></script>')],
    ['weebcentral — server-rendered HTML, no embedded JSON of any kind', WEEBCENTRAL_PAGE],
  ];

  for (const [name, html] of absent) {
    test(`${name} → 'not-found', not 'unparseable'`, () => {
      const err = reasonOf(() => extractEmbeddedJson(html, { source: 'https://example.test/ch/1' }));
      assert.equal(err.reason, 'not-found', name);
      assert.match(err.message, /https:\/\/example\.test\/ch\/1/);
    });
  }

  test('weebcentral: a failed GUESS is not reported as a corruption', () => {
    // `var readingStylesWithPage = ['single_page', …]` is valid JS and not JSON. The inline-
    // assignment scanner finds it on every weebcentral page. If a failed guess were promoted to
    // 'unparseable', every provider on a plain-HTML site would report a format change forever.
    assert.equal(reasonOf(() => extractEmbeddedJson(WEEBCENTRAL_PAGE)).reason, 'not-found');
    // …but a caller who asked for that shape BY NAME gets the diagnosis, not silence
    const err = reasonOf(() => extractEmbeddedJson(WEEBCENTRAL_PAGE, { shapes: ['global-assign'] }));
    assert.equal(err.reason, 'unparseable');
    assert.equal(err.locator, 'var readingStylesWithPage');
  });

  test('one broken blob does not hide the readable ones', () => {
    const html = page(
      '<script type="application/json">{oops</script>' + '<script type="application/json">{"good":true}</script>'
    );
    assert.deepEqual(extractEmbeddedJson(html, { shapes: ['json-script'] }), { good: true });
    assert.equal(findEmbeddedJson(html, { shapes: ['json-script'] }).length, 1);
  });

  test('findEmbeddedJson returns [] for an absence but THROWS when everything was broken', () => {
    assert.deepEqual(findEmbeddedJson(page('<p>nothing here</p>')), []);
    assert.throws(
      () => findEmbeddedJson(page('<script type="application/json">{oops</script>'), { shapes: ['json-script'] }),
      err => err instanceof EmbeddedJsonError && err.reason === 'unparseable'
    );
  });

  test('a `where` that matches nothing is an absence, not a corruption', () => {
    const err = reasonOf(() => extractEmbeddedJson(MANGAPARK_PAGE, { shapes: ['ld+json'], where: () => false }));
    assert.equal(err.reason, 'not-found');
  });

  test('no input is ever answered with undefined', () => {
    // This codebase has been burned repeatedly by silent degradation hiding a real fault: a format
    // change must surface as an error, never as "no chapters found".
    for (const [name, html] of [...malformed, ...absent]) {
      let returned;
      try {
        returned = extractEmbeddedJson(html);
      } catch (err) {
        assert.ok(err instanceof EmbeddedJsonError, `${name}: threw a non-EmbeddedJsonError: ${err}`);
        continue;
      }
      assert.fail(`${name}: silently returned ${JSON.stringify(returned)} instead of throwing`);
    }
  });

  test('the not-found message says what it was looking for', () => {
    const err = reasonOf(() =>
      extractEmbeddedJson(page('<p>x</p>'), { shapes: ['next-data'], locator: /Reader/, source: 'flame' })
    );
    assert.match(err.message, /next-data/);
    assert.match(err.message, /Reader/);
  });

  test('an unknown shape name is rejected rather than quietly ignored', () => {
    assert.throws(() => extractEmbeddedJson(page('<p>x</p>'), { shapes: ['__NUXT__'] }), EmbeddedJsonError);
    assert.deepEqual([...EMBEDDED_JSON_SHAPES].sort(), [
      'astro-props',
      'global-assign',
      'json-script',
      'ld+json',
      'next-data',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * hostile input — the RCE suite's method, applied to this parser
 * ------------------------------------------------------------------ */

describe('hostile pages execute nothing', () => {
  test('the naive sink runs page-supplied code — and looks successful doing it', () => {
    // proves the fixture below is genuinely live, so the assertions after it mean something
    const payload = `{pages: (globalThis['${CANARY}']='pwned', ['https://cdn.example/1.jpg'])}`;
    const returned = oldSink(payload);
    assert.equal(globalThis[CANARY], 'pwned', 'fixture is not actually hostile — the rest proves nothing');
    assert.deepEqual(returned.pages, ['https://cdn.example/1.jpg']); // caller sees a normal page list
  });

  test('the same blob in a page is refused loudly and never evaluated', () => {
    const html = page(`<script>window.__DATA__ = {pages: (globalThis['${CANARY}']='pwned', ['x.jpg'])};</script>`);
    assert.equal(globalThis[CANARY], undefined);
    const err = reasonOf(() => extractEmbeddedJson(html, { shapes: ['global-assign'], source: 'hostile' }));
    assert.equal(err.reason, 'unparseable');
    assert.equal(err.locator, 'window.__DATA__');
    assert.equal(globalThis[CANARY], undefined, 'page-supplied code executed');
  });

  test('code hidden inside WELL-FORMED JSON comes back as inert text', () => {
    const attack = `');globalThis['${CANARY}']='pwned';('`;
    const html = page(nextData({ props: { pageProps: { chapter: { images: { 0: { name: attack } } } } } }));
    const data = extractEmbeddedJson(html, { shapes: ['next-data'] });
    assert.equal(data.props.pageProps.chapter.images[0].name, attack); // full fidelity — it is a string
    assert.equal(globalThis[CANARY], undefined);
  });

  test('the same, through the Astro attribute path', () => {
    const attack = `<img src=x onerror="globalThis['${CANARY}']='pwned'">`;
    const props = extractEmbeddedJson(page(astroIsland({ title: [0, attack] })), { shapes: ['astro-props'] });
    assert.equal(props.title, attack);
    assert.equal(globalThis[CANARY], undefined);
  });

  test('a JSON string that closes the script tag and opens a new one is not obeyed', () => {
    const html = page(
      `<script id="__NEXT_DATA__" type="application/json">{"x":"\\u003c/script>\\u003cscript>globalThis['${CANARY}']='pwned'\\u003c/script>"}</script>`
    );
    const data = extractEmbeddedJson(html, { shapes: ['next-data'] });
    assert.match(data.x, /onerror|script/);
    assert.equal(globalThis[CANARY], undefined);
  });

  test('__proto__ in the payload does not reach Object.prototype', () => {
    // JSON.parse defines __proto__ as an own data property rather than invoking the setter, so the
    // parse itself is safe — but the key survives into the returned object and turns any naive
    // downstream merge into a real prototype write. It is stripped.
    for (const html of [
      page(nextData({ __proto__: { polluted: 'yes' }, ok: 1 })),
      page(nextData({ props: { nested: { __proto__: { polluted: 'yes' }, ok: 1 } } })),
      page('<script type="application/json">{"__proto__":{"polluted":"yes"},"ok":1}</script>'),
      page(astroIsland({ __proto__: [0, { polluted: [0, 'yes'] }], ok: [0, 1] })),
      page(`<script>window.__DATA__ = {"__proto__":{"polluted":"yes"},"ok":1};</script>`),
    ]) {
      const data = extractEmbeddedJson(html);
      assert.equal({}.polluted, undefined, 'Object.prototype was polluted');
      assert.equal(Object.prototype.polluted, undefined);
      const flat = JSON.stringify(data);
      assert.equal(flat.includes('polluted'), false, `__proto__ survived into ${flat}`);
    }
    assert.equal({}.polluted, undefined);
  });

  test('constructor/prototype keys stay inert own properties', () => {
    const data = extractEmbeddedJson(page(nextData({ constructor: { prototype: { polluted: 'yes' } } })));
    assert.equal({}.polluted, undefined);
    assert.equal(data.constructor.prototype.polluted, 'yes'); // plain data, no gadget reached
  });

  test('a giant unbalanced payload neither hangs nor throws something unexpected', () => {
    const bomb = page(`<script>window.__X__ = ${'{"a":'.repeat(200000)}</script>`);
    const started = Date.now();
    const err = reasonOf(() => extractEmbeddedJson(bomb));
    assert.equal(err.reason, 'not-found'); // never closes, so it was never a value
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms — scanner is not linear`);
  });

  test('deep nesting is a bad payload, not an escaped stack overflow', () => {
    // Both parse paths walk a tree the remote site shaped. Whether V8 or the Astro decoder gives
    // out first, the caller must see an EmbeddedJsonError — never a raw RangeError escaping the
    // provider and never a partial result.
    let tuple = '[0,null]';
    for (let i = 0; i < 20000; i++) tuple = `[0,{"a":${tuple}}]`;

    for (const html of [
      page(`<script type="application/json">${'['.repeat(60000)}${']'.repeat(60000)}</script>`),
      page(`<astro-island component-url="/x.js" props="${htmlEscapeAttr(`{"a":${tuple}}`)}"></astro-island>`),
    ]) {
      try {
        extractEmbeddedJson(html);
      } catch (err) {
        assert.ok(err instanceof EmbeddedJsonError, `leaked a raw ${err && err.name}: ${err}`);
      }
    }
  });

  test('maxBytes rejects an oversized blob instead of parsing it', () => {
    const html = page(nextData({ pad: 'x'.repeat(5000) }));
    const err = reasonOf(() => extractEmbeddedJson(html, { maxBytes: 512, source: 'flame' }));
    assert.equal(err.reason, 'unparseable');
    assert.match(err.message, /512/);
    // and the same page is fine under the default cap
    assert.equal(extractEmbeddedJson(html).pad.length, 5000);
  });

  test('the shipped module contains no eval, Function constructor, or vm', () => {
    // The structural guard. unpack-packer exists because these call sites used to eval remote text;
    // this parser must never acquire one, and a comment saying so is not enforcement.
    const src = readFileSync(new URL('../dist/utils/embedded-json.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\beval\s*\(/, 'eval() reintroduced');
    assert.doesNotMatch(src, /\bnew\s+Function\b/, 'new Function reintroduced');
    assert.doesNotMatch(src, /\brequire\s*\(\s*['"](vm|node:vm|child_process)['"]/, 'a code-execution module was imported');
    // exactly one `new RegExp`: the locator filter copying the CALLER's regexp to drop /g/. Any
    // second one is a pattern being compiled from page text, i.e. a ReDoS primitive.
    assert.equal((src.match(/\bnew RegExp\b/g) ?? []).length, 1, 'a RegExp may be being built from page text');
  });
});

/* ------------------------------------------------------------------ *
 * decodeAstroProps
 * ------------------------------------------------------------------ */

describe('decodeAstroProps — Astro v5 [typeCode, value] tuples', () => {
  test('codes 0 and 1, the only two the real pages use', () => {
    assert.deepEqual(decodeAstroProps({ s: [0, 'x'], n: [0, 5], b: [0, false], z: [0, null] }), {
      s: 'x',
      n: 5,
      b: false,
      z: null,
    });
    assert.deepEqual(decodeAstroProps({ p: [1, [[0, { u: [0, 'a.webp'] }], [0, { u: [0, 'b.webp'] }]]] }), {
      p: [{ u: 'a.webp' }, { u: 'b.webp' }],
    });
  });

  test('a one-element tuple is Astro undefined, and the key survives', () => {
    const out = decodeAstroProps({ chapterTitle: [0] });
    assert.equal(out.chapterTitle, undefined);
    assert.equal('chapterTitle' in out, true);
  });

  test('codes 2-11 decode to plain data, never to a live object', () => {
    const out = decodeAstroProps({
      re: [2, '(a+)+b'],
      dt: [3, '2026-01-01T00:00:00.000Z'],
      mp: [
        4,
        [
          [
            1,
            [
              [0, 'k'],
              [0, 'v'],
            ],
          ],
        ],
      ],
      st: [
        5,
        [
          [0, 1],
          [0, 2],
        ],
      ],
      bi: [6, '900719925474099123'],
      url: [7, 'https://cdn.example/x'],
      u8: [8, [1, 2, 3]],
      inf: [11, -1],
    });
    // no RegExp is compiled from remote text — a pattern the site chose is a ReDoS primitive
    assert.equal(out.re, '(a+)+b');
    assert.equal(out.re instanceof RegExp, false);
    assert.equal(out.dt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(out.mp, [['k', 'v']]);
    assert.deepEqual(out.st, [1, 2]);
    assert.equal(out.bi, '900719925474099123');
    assert.equal(out.url, 'https://cdn.example/x');
    assert.deepEqual(out.u8, [1, 2, 3]);
    assert.equal(out.inf, -Infinity);
  });

  test('an unknown type code throws with the JSON path, instead of Astro undefined', () => {
    // astro-island's own `o` returns void 0 for an unrecognised code. Copying that would put this
    // module back in the fail-open business the moment Astro adds a type.
    const err = reasonOf(() => decodeAstroProps({ pages: [1, [[0, { at: [12, 'x'] }]]] }, 'asura'));
    assert.equal(err.reason, 'unparseable');
    assert.match(err.message, /props\.pages\[0\]\.at/);
    assert.match(err.message, /12/);
    assert.match(err.message, /asura/);
  });

  test('a malformed tuple throws with the JSON path', () => {
    assert.match(reasonOf(() => decodeAstroProps({ a: 'bare' }, 's')).message, /props\.a/);
    assert.match(reasonOf(() => decodeAstroProps({ a: [0, { b: 7 }] }, 's')).message, /props\.a\.b/);
    assert.match(reasonOf(() => decodeAstroProps({ a: [1, 'not-an-array'] }, 's')).message, /props\.a/);
    assert.match(reasonOf(() => decodeAstroProps({ a: [0, 1, 2, 3] }, 's')).message, /props\.a/);
  });

  test('a non-object at the top is returned unchanged, as astro-island does', () => {
    assert.equal(decodeAstroProps(null), null);
    assert.equal(decodeAstroProps('x'), 'x');
    assert.deepEqual(decodeAstroProps({}), {});
  });
});
