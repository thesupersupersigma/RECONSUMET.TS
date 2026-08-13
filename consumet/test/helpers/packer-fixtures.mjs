// Shared fixtures for the P.A.C.K.E.R tests.
//
// `PACKER_RUNTIME` is the real, verbatim Dean Edwards bootstrap — the `function(p,a,c,k,e,d){…}`
// that ships inside every packed script (kwik's, MixDrop's, StreamHub's, mangahere's). It is used
// two ways: as the ORACLE that says what a payload is supposed to expand to, and as the body of the
// synthetic pages the tests feed in. It only ever runs over payloads built in this file.
//
// Which branch is ground truth: in Node `''.replace(/^/,String)` is `''`, so the runtime takes its
// dictionary branch — one pass of `p.replace(/\b\w+\b/g, tok => d[tok])`. That is what the old
// `eval` actually did, and what unpackPacker reimplements. (The legacy sequential-regex branch is
// dead code on any modern engine.)

export const PACKER_RUNTIME = String.raw`function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c])}}return p}`;

/** the packer's own expansion, ground truth for the format */
const runtime = new Function(`return (${PACKER_RUNTIME})`)();
export const expand = p => runtime(p.payload, p.radix, p.count, p.words, 0, {});

/** the packer's base-N token alphabet: 0-9 → '0'-'9', 10-35 → 'a'-'z', 36-61 → 'A'-'Z' */
export const token = (n, radix) => {
  let out = '';
  do {
    const r = n % radix;
    out = (r < 10 ? String(r) : r < 36 ? String.fromCharCode(87 + r) : String.fromCharCode(29 + r)) + out;
    n = Math.floor(n / radix);
  } while (n > 0);
  return out;
};

/** pack `source` the way the packer does: every \w+ run becomes a base-N token + keyword table entry */
export const pack = (source, radix) => {
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
export const esc = s =>
  s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');

/** the packed `eval(...)` call on its own, as it appears inside a page */
export const packedCall = packed =>
  `eval(${PACKER_RUNTIME}('${esc(packed.payload)}',${packed.radix},${packed.count},'${packed.words.join('|')}'.split('|'),0,{}))`;

/** an embed page wrapping a packed script, shaped like the real ones */
export const buildPage = (packed, extraHtml = '') =>
  `<!DOCTYPE html><html><head><title>embed</title></head><body>${extraHtml}
<script type="text/javascript">${packedCall(packed)}
</script></body></html>`;

/** the extraction these callers perform on the unpacked text */
export const M3U8 = /https?:\/\/[^"'\s]+?\.m3u8/;

/** global set by the hostile fixtures below if page-supplied code ever runs */
export const CANARY = '__PACKER_RCE_CANARY__';

/**
 * The exact sink every one of these call sites used to have:
 *   eval(/(eval)(\(f.*?)(\n<\/script>)/s.exec(data)![2].replace('eval', ''))
 * `[2]` is everything from `(f` to just before `\n</script>` — so the scraped host chose the entire
 * string handed to eval, and it never had to be a packer at all: any expression starting with `f`
 * (i.e. an IIFE) ran with this process's privileges. Reproduced here so the "does not execute"
 * assertions prove something: the fixture is demonstrably live code.
 */
export const oldSink = page => {
  const packed = /(eval)(\(f.*?)(\n<\/script>)/s.exec(page);
  if (!packed) throw new Error('no packed player script');
  return new Function(`return ${packed[2].replace('eval', '')}`)();
};

/**
 * A hostile embed that is NOT a packer: it runs code and returns believable-looking player source,
 * so under the old sink the compromise looked like a perfectly normal successful extraction.
 * `returns` is the string the IIFE hands back — shaped per caller so each extractor's own parsing
 * would have been satisfied.
 */
export const hostilePage = returns =>
  `<html><body>
<script type="text/javascript">eval(function(){globalThis.${CANARY}='pwned';return ${JSON.stringify(returns)}}())
</script></body></html>`;
