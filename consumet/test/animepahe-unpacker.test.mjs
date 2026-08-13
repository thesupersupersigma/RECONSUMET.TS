// M6 — AnimePahe's P.A.C.K.E.R unpacker.
//
// WHAT THIS PROTECTS. `unpackKwik` used to do `eval(<script fetched from kwik.cx>)`. kwik is a third
// party; that script is entirely under its control, and `eval` ran it with full Node privileges in
// the API process — same process as the HTTP server, its env (API_KEY, curl-impersonate paths) and
// its filesystem/network access. `unpackPacker` replaced it with a deterministic string expansion.
// These tests pin BOTH halves of that: it must produce exactly what the packer produces, and it must
// never execute anything.
//
// ORACLE. `PACKER_RUNTIME` below is the real, verbatim Dean Edwards P.A.C.K.E.R bootstrap — the
// `function(p,a,c,k,e,d){…}` that ships inside every packed script, kwik's included. The tests
// instantiate it once and use it as ground truth for the format. It only ever runs over payloads
// this file builds; nothing here is fetched.
//
// Which branch is ground truth: in Node `''.replace(/^/,String)` is `''`, so the runtime takes its
// dictionary branch — one pass of `p.replace(/\b\w+\b/g, tok => d[tok])`. That is what the old
// `eval` actually did, and it is what `unpackPacker` reimplements. (The legacy sequential-regex
// branch is dead code on any modern engine.)
//
// A REAL kwik payload could not be captured for a fixture: animepahe.pw is behind Cloudflare's
// Managed Challenge (403 without Byparr, which needs Docker), kwik embed ids only come from that
// gated /play page, and the public consumet instance that could have supplied one is retired. The
// bootstrap used here is the same format, from the same packer.
//
// Runs against dist/ — the artifact the API actually loads — so build first:
//   cd consumet && sh scripts/build-gate.sh && node --test 'test/**/*.test.mjs'

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../dist/providers/anime/animepahe.js');
const AnimePahe = mod.default ?? mod;

// `unpackPacker` is private in the TypeScript source — reached here deliberately, because testing the
// shipped method beats testing a copy of it. Signature: (page, embedUrl?) => unpacked source.
assert.equal(typeof AnimePahe.unpackPacker, 'function', 'dist/ is missing AnimePahe.unpackPacker — rebuild it first');
const unpack = (page, url = '<test embed>') => AnimePahe.unpackPacker(page, url);

// verbatim packer bootstrap (String.raw so the `\\w+` / `\\b` escapes stay exactly as in the wild)
const PACKER_RUNTIME = String.raw`function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c])}}return p}`;

/** the packer's own expansion, used as ground truth. Runs only over payloads built in this file. */
const oracle = new Function(`return (${PACKER_RUNTIME})`)();
const expand = p => oracle(p.payload, p.radix, p.count, p.words, 0, {});

/** the packer's base-N token alphabet: 0-9 → '0'-'9', 10-35 → 'a'-'z', 36-61 → 'A'-'Z' */
const token = (n, radix) => {
  let out = '';
  do {
    const r = n % radix;
    out = (r < 10 ? String(r) : r < 36 ? String.fromCharCode(87 + r) : String.fromCharCode(29 + r)) + out;
    n = Math.floor(n / radix);
  } while (n > 0);
  return out;
};

/** pack `source` the way the packer does: every \w+ run becomes a base-N token + keyword table entry */
const pack = (source, radix) => {
  const words = [];
  const seen = new Map();
  const payload = source.replace(/\b\w+\b/g, w => {
    if (!seen.has(w)) {
      seen.set(w, words.length);
      words.push(w);
    }
    return token(seen.get(w), radix);
  });
  return { payload, words, count: words.length, radix };
};

/** JS string-literal escaping, as the packer emits it into the `'<payload>'` argument */
const esc = s =>
  s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');

/** a kwik-shaped embed page wrapping a packed script */
const buildPage = (packed, extraHtml = '') =>
  `<!DOCTYPE html><html><head><title>Kwik</title></head><body>${extraHtml}
<script type="text/javascript">eval(${PACKER_RUNTIME}('${esc(packed.payload)}',${packed.radix},${packed.count},'${packed.words.join('|')}'.split('|'),0,{}))
</script></body></html>`;

/** what a kwik embed really hides: a player bootstrap whose only .m3u8 is the stream */
const KWIK_SOURCE = `(function(){const player=new Plyr('#kwik_player');const source='https://vault-11.uwucdn.top/stream/12/34/8f2a9c/uwu.m3u8';if(Hls.isSupported()){const hls=new Hls({maxBufferLength:30});hls.loadSource(source);hls.attachMedia(player.media);}else{player.media.src=source;}})();`;

/** the extraction unpackKwik performs on the unpacked text */
const M3U8 = /https?:\/\/[^"'\s]+?\.m3u8/;

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
});

describe('unpackPacker — fails loudly, never silently empty', () => {
  const packed = pack(KWIK_SOURCE, 36);
  const page = buildPage(packed);

  // [name, input, expected error]
  const cases = [
    ['no packed script on the page', '<html><body>challenge required</body></html>', /no packed player script/],
    ['empty response body', '', /no packed player script/],
    [
      'packer call with an unrecognised argument shape',
      `<script>eval(${PACKER_RUNTIME}('payload',36))\n</script>`,
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
    ['truncated packed script (no closing </script>)', page.replace('\n</script></body></html>', ''), /no packed player script/],
  ];

  for (const [name, input, expected] of cases) {
    test(`${name} → throws`, () => {
      assert.throws(() => unpack(input), expected);
    });
  }

  test('the error names the embed it came from, so a kwik format change is diagnosable', () => {
    assert.throws(() => unpack('<html></html>', 'https://kwik.cx/e/BROKEN'), /https:\/\/kwik\.cx\/e\/BROKEN/);
  });

  test('no malformed input is answered with an empty string', () => {
    // This codebase has been burned by silent degradation hiding real faults: a kwik format change
    // must surface as an error, never as "no sources found".
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
  const CANARY = '__PAHE_RCE_CANARY__';

  // The exact old sink:
  //     const packed = /(eval)(\(f.*?)(\n<\/script>)/s.exec(data);
  //     const unpacked: string = eval(packed[2].replace('eval', ''));
  // packed[2] is everything from `(f` to just before `\n</script>` — i.e. kwik chose the entire
  // string handed to eval. It never had to be a packer at all: any expression starting with "(f"
  // ran, with whatever privileges the API process holds.
  const oldSink = page => {
    const packed = /(eval)(\(f.*?)(\n<\/script>)/s.exec(page);
    if (!packed) throw new Error('no packed player script');
    return new Function(`return ${packed[2].replace('eval', '')}`)();
  };

  // A hostile embed that is NOT a packer: it runs code and hands back a believable stream url, so
  // the caller's m3u8 regex matches and the compromise looks like a normal successful playback.
  // (The only shape constraint the old regex imposed was "starts with `f`" — so, an IIFE.)
  const hostilePage = `<html><body>
<script type="text/javascript">eval(function(){globalThis.${CANARY}='pwned';return 'const s="https://vault-1.uwucdn.top/a/b.m3u8"'}())
</script></body></html>`;

  afterEach(() => {
    delete globalThis[CANARY];
  });

  test('the old eval sink ran page-supplied code — and looked successful doing it', () => {
    const returned = oldSink(hostilePage);
    assert.equal(globalThis[CANARY], 'pwned', 'fixture is not actually hostile — the rest proves nothing');
    assert.equal(returned.match(M3U8)[0], 'https://vault-1.uwucdn.top/a/b.m3u8'); // caller sees a normal stream
  });

  test('unpackPacker refuses that same page loudly and executes nothing', () => {
    assert.equal(globalThis[CANARY], undefined);
    assert.throws(() => unpack(hostilePage, 'https://kwik.cx/e/HOSTILE'), /unrecognised argument shape/);
    assert.equal(globalThis[CANARY], undefined);
  });

  test('code hidden inside a WELL-FORMED packer payload comes back as inert text', () => {
    // the other shape: a genuine packer call whose unpacked source is malicious. The old code did
    // not execute this half (it eval'd the packer, not its output) — but nothing may execute it now
    // either, and the expansion must still be faithful.
    const source = `globalThis.${CANARY}='pwned';const s='https://vault-1.uwucdn.top/a/b.m3u8';`;
    const unpacked = unpack(buildPage(pack(source, 62)));
    assert.equal(unpacked, source); // full fidelity — it is just a string
    assert.equal(unpacked.match(M3U8)[0], 'https://vault-1.uwucdn.top/a/b.m3u8');
    assert.equal(globalThis[CANARY], undefined);
  });

  test('a packer-shaped call whose bootstrap was swapped for an exploit does not run', () => {
    // closest to a real attack: keep the `eval(function(p,a,c,k,e,d){…}('…',36,3,'…'.split('|'),0,{}))
    // shape the parser expects, but make the FUNCTION BODY hostile. The old sink would run the body;
    // unpackPacker never looks at it — it only reads the four arguments as data.
    const page = `<html><body>
<script type="text/javascript">eval(function(p,a,c,k,e,d){globalThis.${CANARY}='pwned';return p}('0 1 2',36,3,'https://vault-1.uwucdn.top/a/b.m3u8|const|s'.split('|'),0,{}))
</script></body></html>`;
    oldSink(page);
    assert.equal(globalThis[CANARY], 'pwned'); // the old sink runs the swapped bootstrap
    delete globalThis[CANARY];

    const unpacked = unpack(page);
    assert.equal(unpacked, 'https://vault-1.uwucdn.top/a/b.m3u8 const s');
    assert.equal(globalThis[CANARY], undefined); // …unpackPacker does not
  });
});
