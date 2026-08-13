// The shared P.A.C.K.E.R unpacker (src/utils/unpack-packer.ts).
//
// WHAT THIS PROTECTS. Five call sites — animepahe/kwik, the Kwik, MixDrop and StreamHub extractors,
// and mangahere (three of them) — used to `eval()` a script fetched from the site they scrape. That
// runs third-party JavaScript with this process's full privileges: in the API server, next to its
// env (API_KEY, curl-impersonate paths) and its filesystem and network access. They now all share
// one deterministic expansion. These tests pin both halves of it: it must produce exactly what the
// packer produces, and it must never execute anything.
//
// A REAL payload could not be captured for a fixture: animepahe.pw is behind Cloudflare's Managed
// Challenge (403 here; the solver needs Byparr, which needs Docker), kwik embed ids only come from
// that gated /play page, and the public consumet instance that could have supplied one is retired.
// The genuine packer bootstrap is used as the oracle instead — same format, same packer.
//
// Runs against dist/ — the artifact the API loads — so build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  PACKER_RUNTIME,
  expand,
  pack,
  esc,
  packedCall,
  buildPage,
  M3U8,
  CANARY,
  oldSink,
  hostilePage,
} from './helpers/packer-fixtures.mjs';

const require = createRequire(import.meta.url);
const { unpackPacker, unpackJsStringConcat, PackerError } = require('../dist/utils/unpack-packer.js');

assert.equal(typeof unpackPacker, 'function', 'dist/ is missing unpackPacker — rebuild it first');

const unpack = (input, source = '<test embed>') => unpackPacker(input, source);

/** what a kwik embed really hides: a player bootstrap whose only .m3u8 is the stream */
const KWIK_SOURCE = `(function(){const player=new Plyr('#kwik_player');const source='https://vault-11.uwucdn.top/stream/12/34/8f2a9c/uwu.m3u8';if(Hls.isSupported()){const hls=new Hls({maxBufferLength:30});hls.loadSource(source);hls.attachMedia(player.media);}else{player.media.src=source;}})();`;

describe('unpackPacker — matches the real packer', () => {
  for (const radix of [10, 36, 62]) {
    test(`radix ${radix}: round-trips a kwik-shaped payload and agrees with the packer runtime`, () => {
      const packed = pack(KWIK_SOURCE, radix);
      const unpacked = unpack(buildPage(packed));

      assert.equal(unpacked, expand(packed), 'diverged from the packer runtime');
      assert.equal(unpacked, KWIK_SOURCE, 'did not round-trip to the original source');
      assert.equal(unpacked.match(M3U8)[0], 'https://vault-11.uwucdn.top/stream/12/34/8f2a9c/uwu.m3u8');
    });
  }

  test('handles a keyword table larger than the radix (multi-character tokens)', () => {
    // 120 distinct words at radix 10 → tokens run '0'..'119', i.e. 1-, 2- and 3-character tokens
    const source = Array.from({ length: 120 }, (_, i) => `var name${i}=${i};`).join('');
    const packed = pack(source, 10);
    assert.ok(packed.count > 120, `expected >120 keywords, got ${packed.count}`);
    const unpacked = unpack(buildPage(packed));
    assert.equal(unpacked, expand(packed));
    assert.equal(unpacked, source);
  });

  test('does not corrupt keywords that contain a token as a substring', () => {
    // The hazard a sequential `while(c--) p.replace(...)` unpacker hits: at radix 10 the tokens are
    // digits, and these keywords contain digits, so a later pass would rewrite text it already
    // substituted. One dictionary pass (what the packer's own branch does) is immune.
    const source = `const m3u8='x1y';const sha1=vault11+id2;const a1b1='0';`;
    const packed = pack(source, 10);
    const unpacked = unpack(buildPage(packed));
    assert.equal(unpacked, expand(packed));
    assert.equal(unpacked, source);
  });

  test('unescapes the payload literal (quotes, backslashes, newlines, tabs)', () => {
    const source = `const re=/https?:\\/\\/[^'"]+/;\n\tconst q='it\\'s';\nconsole.log("a\\\\b");`;
    const packed = pack(source, 36);
    const unpacked = unpack(buildPage(packed));
    assert.equal(unpacked, expand(packed));
    assert.equal(unpacked, source);
  });

  test('maps a blank keyword-table entry to the token itself, like the packer does', () => {
    // k[c] === '' means "this token stands for itself" (the packer's `k[c]||e(c)`).
    const packed = { payload: '0 1 2', words: ['alpha', '', 'beta'], count: 3, radix: 36 };
    const unpacked = unpack(buildPage(packed));
    assert.equal(unpacked, expand(packed));
    assert.equal(unpacked, 'alpha 1 beta');
  });

  test('leaves an unknown token alone instead of writing "undefined" into the output', () => {
    // The packer's own dictionary branch would emit the string "undefined" here (d[tok] is unset).
    // Leaving the token untouched is the deliberate, safer difference — the m3u8 stays readable.
    const packed = { payload: '0 zzz 1', words: ['alpha', 'beta'], count: 2, radix: 36 };
    assert.equal(unpack(buildPage(packed)), 'alpha zzz beta');
  });

  test('finds the packed script even when the page carries other scripts and markup', () => {
    const packed = pack(KWIK_SOURCE, 36);
    const noise = `<script>var _0x=1;</script><div class="ad" data-src="https://ads.example/x.js"></div>`;
    assert.equal(unpack(buildPage(packed, noise)), KWIK_SOURCE);
  });

  test('accepts a bare packer call, not just a whole page', () => {
    // mangahere's chapterfun.ashx answers with the call and nothing else — no HTML around it.
    const packed = pack(KWIK_SOURCE, 36);
    assert.equal(unpack(packedCall(packed)), KWIK_SOURCE);
    assert.equal(unpack(packedCall(packed).replace('eval', '')), KWIK_SOURCE);
  });

  test('stops at </script>, so a later script cannot be spliced into the first one arguments', () => {
    // Without the bound, the greedy payload group would reach past the real invocation and pick up
    // a second `.split('|')` further down the page.
    const first = pack(`const a='https://real.example/a.m3u8';`, 36);
    const second = pack(`const b='https://attacker.example/b.m3u8';`, 36);
    const page = `${buildPage(first)}\n<script>${packedCall(second)}\n</script>`;
    assert.equal(unpack(page), `const a='https://real.example/a.m3u8';`);
  });
});

describe('unpackPacker — fails loudly, never silently empty', () => {
  const packed = pack(KWIK_SOURCE, 36);
  const page = buildPage(packed);

  // [name, input, expected error]
  const cases = [
    ['no packed script on the page', '<html><body>challenge required</body></html>', /no P\.A\.C\.K\.E\.R script found/],
    ['empty response body', '', /no P\.A\.C\.K\.E\.R script found/],
    [
      'an ordinary function, not the packer signature',
      `<script>eval(function(x){return x}(1))\n</script>`,
      /no P\.A\.C\.K\.E\.R script found/,
    ],
    [
      'packer signature but no arguments',
      `<script>eval(${PACKER_RUNTIME}('payload',36))\n</script>`,
      /unrecognised argument shape/,
    ],
    [
      'payload truncated mid-call',
      page.slice(0, page.indexOf(".split('|')")),
      /unrecognised argument shape/,
    ],
    ['radix below 2', page.replace(`',${packed.radix},`, `',1,`), /invalid radix/],
    ['radix above 62', page.replace(`',${packed.radix},`, `',63,`), /invalid radix/],
    ['implausible symbol count', page.replace(`,${packed.count},`, `,99999999,`), /implausible symbol count/],
    [
      'keyword table shorter than the declared count',
      page.replace(`,${packed.count},`, `,${packed.count + 5},`),
      /shorter than declared count/,
    ],
  ];

  for (const [name, input, expected] of cases) {
    test(`${name} → throws`, () => {
      assert.throws(() => unpack(input), expected);
      assert.throws(() => unpack(input), PackerError);
    });
  }

  test('the error names the source it came from, so a format change is diagnosable', () => {
    assert.throws(() => unpack('<html></html>', 'https://kwik.cx/e/BROKEN'), /https:\/\/kwik\.cx\/e\/BROKEN/);
  });

  test('no malformed input is answered with an empty string', () => {
    // This codebase has been burned by silent degradation hiding real faults: a format change must
    // surface as an error, never as "no sources found".
    for (const [name, input] of cases) {
      let returned;
      try {
        returned = unpack(input);
      } catch {
        continue; // threw — correct
      }
      assert.fail(`${name}: silently returned ${JSON.stringify(returned)} instead of throwing`);
    }
  });
});

describe('unpackPacker — the RCE is actually closed', () => {
  const returns = `const s="https://vault-1.uwucdn.top/a/b.m3u8"`;
  const page = hostilePage(returns);

  afterEach(() => {
    delete globalThis[CANARY];
  });

  test('the old eval sink ran page-supplied code — and looked successful doing it', () => {
    const returned = oldSink(page);
    assert.equal(globalThis[CANARY], 'pwned', 'fixture is not actually hostile — the rest proves nothing');
    assert.equal(returned.match(M3U8)[0], 'https://vault-1.uwucdn.top/a/b.m3u8'); // caller sees a normal stream
  });

  test('unpackPacker refuses that same page loudly and executes nothing', () => {
    assert.equal(globalThis[CANARY], undefined);
    assert.throws(() => unpack(page, 'https://kwik.cx/e/HOSTILE'), /no P\.A\.C\.K\.E\.R script found/);
    assert.equal(globalThis[CANARY], undefined);
  });

  test('a packer-shaped call whose bootstrap was swapped for an exploit does not run', () => {
    // Closest to a real attack: keep the shape the parser expects, but make the FUNCTION BODY
    // hostile. The old sink runs the body; unpackPacker never looks at it — it reads only the four
    // arguments, as data.
    const swapped = `<html><body>
<script type="text/javascript">eval(function(p,a,c,k,e,d){globalThis.${CANARY}='pwned';return p}('0 1 2',36,3,'https://vault-1.uwucdn.top/a/b.m3u8|const|s'.split('|'),0,{}))
</script></body></html>`;
    oldSink(swapped);
    assert.equal(globalThis[CANARY], 'pwned');
    delete globalThis[CANARY];

    assert.equal(unpack(swapped), 'https://vault-1.uwucdn.top/a/b.m3u8 const s');
    assert.equal(globalThis[CANARY], undefined);
  });

  test('code hidden inside a WELL-FORMED packer payload comes back as inert text', () => {
    const source = `globalThis.${CANARY}='pwned';const s='https://vault-1.uwucdn.top/a/b.m3u8';`;
    const unpacked = unpack(buildPage(pack(source, 62)));
    assert.equal(unpacked, source); // full fidelity — it is just a string
    assert.equal(unpacked.match(M3U8)[0], 'https://vault-1.uwucdn.top/a/b.m3u8');
    assert.equal(globalThis[CANARY], undefined);
  });
});

// mangahere's key is built by the unpacked script as a concatenation of literals, and used to be
// read with a SECOND eval. That one is not a packer, so it gets its own parser.
describe('unpackJsStringConcat — the non-packer eval mangahere also had', () => {
  afterEach(() => {
    delete globalThis[CANARY];
  });

  test('concatenates single-quoted literals, mangahere-style', () => {
    assert.equal(unpackJsStringConcat(`''+'e'+'8'+'c'+'1'`), 'e8c1');
    assert.equal(unpackJsStringConcat(`'8a4f2b'`), '8a4f2b');
  });

  test('tolerates whitespace and double quotes', () => {
    assert.equal(unpackJsStringConcat(`  'a' + "b" +'c'  `), 'abc');
  });

  test('unescapes literals without evaluating them', () => {
    assert.equal(unpackJsStringConcat(String.raw`'a\'b'+'c\\d'`), `a'bc\\d`);
  });

  test('refuses anything that is not literals joined by + — including live code', () => {
    for (const expr of [
      `'a'+(globalThis.${CANARY}='pwned')`, // ← would execute under eval
      `require('fs').readFileSync('/etc/passwd')`,
      `'a'-'b'`,
      `'a' 'b'`,
      `key`,
      `'a'+`,
      ``,
    ]) {
      assert.throws(() => unpackJsStringConcat(expr, 'mangahere key'), PackerError, `accepted: ${expr}`);
    }
    assert.equal(globalThis[CANARY], undefined, 'an expression was executed');
  });

  test('errors name the source', () => {
    assert.throws(() => unpackJsStringConcat('alert(1)', 'mangahere key'), /mangahere key/);
  });
});
