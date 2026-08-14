/**
 * Deterministic extraction of the JSON a page has embedded in its own HTML — the one
 * implementation, shared by every provider whose "page" is really a shell around a data blob.
 *
 * WHY THIS EXISTS. A growing share of the sites this repo scrapes render nothing useful into their
 * markup. The chapter's page list arrives as JSON parked somewhere in the document, and the DOM is
 * built from it in the browser. Four shapes cover essentially all of them:
 *
 *   Next.js      <script id="__NEXT_DATA__" type="application/json">{…}</script>
 *   plain JSON   <script type="application/json">{…}</script>
 *   schema.org   <script type="application/ld+json">{…}</script>
 *   Astro v5     <astro-island props="{&quot;pages&quot;:[1,[…]]}" component-url="…">
 *   inline JS    <script>window.__DATA__ = {…}</script>
 *
 * Written per provider that is four hand-rolled cheerio blocks, four subtly different notions of
 * "the JSON wasn't there", and four chances to return `undefined` when the site changes shape. The
 * providers this repo is deleting for being fail-open failed in exactly that way. This is that
 * logic once, with one failure vocabulary.
 *
 * WHERE IT LIVES, AND HOW TO IMPORT IT. Next to `unpack-packer.ts`, the other shared
 * hostile-input parser, for the same reason: it is a leaf utility with no provider knowledge.
 * Import it by PATH — `import { extractEmbeddedJson } from '../../utils/embedded-json'` — and
 * never through the `../../utils` barrel. `utils/index.ts` imports `../extractors`, so going
 * through the barrel from a provider closes a require cycle and yields a half-initialised module.
 * `unpack-packer` is deliberately absent from that barrel too.
 *
 * WHAT WAS ACTUALLY OBSERVED (checked against live pages on 2026-08-14, residential egress):
 *   flamecomics.xyz/series/104/<token>   `#__NEXT_DATA__` → props.pageProps.chapter.images,
 *                                        an index-keyed object of {name,width,height,size}
 *   asurascans.com/comics/<slug>/chapter/N
 *                                        exactly one <astro-island>, ChapterReader, whose 44 KB
 *                                        entity-escaped `props` holds pages/chapterList/prev/next
 *   mangapark.cc/read/<slug>/en/chapter-N
 *                                        no JS state at all — two `application/ld+json` blocks
 *                                        (Article + BreadcrumbList) and server-rendered markup
 *   weebcentral.com/chapters/<ulid>      NO embedded JSON of any kind. It is server-rendered HTML
 *                                        with htmx partials (`/chapters/<ulid>/images` answers
 *                                        with an HTML fragment of <img> tags). Do not reach for
 *                                        this helper there; use cheerio selectors.
 *
 * NO EVAL. This parses bytes a third-party site chose. Nothing here executes, compiles, or
 * constructs a live object from remote text — no `eval`, no `new Function`, and deliberately no
 * `new RegExp` (see `decodeAstroProps`). The only interpreter involved is `JSON.parse`, plus a
 * string-aware brace scanner for the inline-assignment case. `test/extractors-packer-rce.test.mjs`
 * exists because this repo already had that bug once; do not reintroduce it here.
 *
 * FAILURE MODE. `extractEmbeddedJson` throws — it never answers `undefined`. Crucially it
 * distinguishes the two faults that get conflated, because they need different fixes:
 *   'not-found'    the page had no blob of the requested shape at all — the site changed, or you
 *                  were served a challenge/error page instead of the real one.
 *   'unparseable'  a blob WAS there and could not be read — a truncated response, an unescaped
 *                  `</script>` inside a string, or a payload that is JS-object syntax, not JSON.
 * Both carry the caller's `source` label, so a format change says WHICH host changed.
 */

import { CheerioAPI, load } from 'cheerio';

/** The document layouts this helper knows how to find JSON in. */
export type EmbeddedJsonShape = 'next-data' | 'json-script' | 'ld+json' | 'astro-props' | 'global-assign';

/**
 * Default search order: most specific first, so `extractEmbeddedJson` with no `shapes` returns the
 * page's real state blob rather than its schema.org boilerplate. The shapes are mutually exclusive
 * by construction — `json-script` excludes `#__NEXT_DATA__` — so a blob is never reported twice.
 */
export const EMBEDDED_JSON_SHAPES: readonly EmbeddedJsonShape[] = [
  'next-data',
  'astro-props',
  'json-script',
  'ld+json',
  'global-assign',
];

/** Which of the two distinct faults occurred. See the FAILURE MODE note above. */
export type EmbeddedJsonFailure = 'not-found' | 'unparseable';

/** Thrown when embedded JSON cannot be produced. Carries the caller's source label for diagnosis. */
export class EmbeddedJsonError extends Error {
  /** 'not-found' — nothing of that shape on the page. 'unparseable' — something was, and it broke. */
  readonly reason: EmbeddedJsonFailure;
  /** where on the page the fault was, e.g. `script#__NEXT_DATA__`; absent for 'not-found'. */
  readonly locator?: string;

  constructor(message: string, reason: EmbeddedJsonFailure, locator?: string) {
    super(message);
    this.name = 'EmbeddedJsonError';
    this.reason = reason;
    this.locator = locator;
  }
}

/** One successfully parsed blob. */
export interface EmbeddedJson {
  /** which layout it came from */
  readonly shape: EmbeddedJsonShape;
  /** a human-readable address on the page — also what `options.locator` filters against */
  readonly locator: string;
  /** the parsed value. `unknown` on purpose: narrow it, do not cast it. */
  readonly data: unknown;
  /** the JSON text that was parsed, after HTML-entity decoding. For error reports and tests. */
  readonly text: string;
}

export interface EmbeddedJsonOptions {
  /** restrict and order the search. Default {@link EMBEDDED_JSON_SHAPES}. */
  readonly shapes?: readonly EmbeddedJsonShape[];
  /**
   * only accept blobs whose {@link EmbeddedJson.locator} matches — a substring, or a RegExp.
   * This is how you pick one Astro island out of the twenty on a page:
   * `{ shapes: ['astro-props'], locator: /ChapterReader/ }`.
   */
  readonly locator?: string | RegExp;
  /**
   * only accept blobs whose parsed value satisfies this. Runs after parsing, so it is how you pick
   * the `BreadcrumbList` out of four `ld+json` blocks. Must not throw.
   */
  readonly where?: (data: unknown) => boolean;
  /** label used in error messages. The page URL is ideal — it says WHICH host changed. */
  readonly source?: string;
  /** reject any single blob longer than this. Default 4 MiB. Guards against a hostile response. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** inline scripts are noisy; stop hunting for `window.X = {…}` in one after this many hits */
const MAX_GLOBAL_ASSIGNMENTS_PER_SCRIPT = 32;
/** the `type` values a browser would actually execute — only those are scanned for assignments */
const EXECUTABLE_SCRIPT_TYPES = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

/**
 * Drop `__proto__` while parsing. `JSON.parse` itself is safe — it defines `__proto__` as an own
 * data property rather than invoking the setter — but the returned object then carries a key that
 * turns any naive downstream merge (`target[k] = source[k]`) into a real prototype write. Nothing a
 * manga site legitimately sends has this key, so removing it costs nothing and closes the gadget.
 * A reviver that returns `undefined` deletes the property.
 */
const dropProtoKeys = (key: string, value: unknown): unknown => (key === '__proto__' ? undefined : value);

/** internal: something on the page that MIGHT be embedded JSON, not yet parsed */
interface Candidate {
  readonly shape: EmbeddedJsonShape;
  readonly locator: string;
  readonly text: string;
}

/**
 * Find every readable embedded JSON blob on the page, in {@link EMBEDDED_JSON_SHAPES} order.
 *
 * Returns `[]` **only** when the page contained no candidate of the requested shapes at all. If
 * candidates existed and none of them could be read, it throws `'unparseable'` instead: "there was
 * JSON here and it changed" is a different fault from "this page has no embedded JSON", and
 * reporting the first as an empty array is the fail-open pattern this module exists to end. A
 * malformed candidate sitting alongside readable ones is skipped — ad and analytics scripts trip
 * the inline-assignment scanner constantly and must not poison a search that otherwise succeeded.
 * For the same reason a `global-assign` candidate that fails to parse is only promoted to a thrown
 * error when `options.shapes` named that shape: during a default sweep it is a guess, not a claim.
 *
 * @param html the page source, or a `CheerioAPI` you have already loaded (pass the latter to avoid
 *             parsing a 600 KB document twice).
 */
export function findEmbeddedJson(html: string | CheerioAPI, options: EmbeddedJsonOptions = {}): EmbeddedJson[] {
  return scan(html, options, Infinity);
}

/**
 * The first embedded JSON blob matching `options`, as a value to narrow. Throws rather than
 * returning `undefined`.
 *
 * ```ts
 * // FlameComics: the whole Next.js page state
 * const next = extractEmbeddedJson(html, { shapes: ['next-data'], source: url });
 *
 * // AsuraScans: one island out of twenty — already put through decodeAstroProps for you
 * const props = extractEmbeddedJson(html, { shapes: ['astro-props'], locator: /ChapterReader/, source: url });
 *
 * // MangaPark: the schema.org block that is actually the article
 * const article = extractEmbeddedJson(html, {
 *   shapes: ['ld+json'],
 *   where: d => typeof d === 'object' && d !== null && (d as { '@type'?: unknown })['@type'] === 'Article',
 * });
 * ```
 *
 * @throws {EmbeddedJsonError} `reason: 'not-found'` if nothing matched, `'unparseable'` if
 *         something matched and could not be read.
 */
export function extractEmbeddedJson(html: string | CheerioAPI, options: EmbeddedJsonOptions = {}): unknown {
  const found = scan(html, options, 1);
  if (found.length === 0) {
    const source = options.source ?? '<embedded json>';
    const shapes = (options.shapes ?? EMBEDDED_JSON_SHAPES).join(', ');
    const where = options.locator === undefined ? '' : `, locator ${describeLocator(options.locator)}`;
    throw new EmbeddedJsonError(`no embedded JSON found (looked for ${shapes}${where}): ${source}`, 'not-found');
  }
  return found[0].data;
}

/** shared implementation; `limit` lets `extractEmbeddedJson` stop after the first hit */
function scan(html: string | CheerioAPI, options: EmbeddedJsonOptions, limit: number): EmbeddedJson[] {
  const source = options.source ?? '<embedded json>';
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const order = options.shapes ?? EMBEDDED_JSON_SHAPES;
  for (const shape of order) {
    if (!EMBEDDED_JSON_SHAPES.includes(shape))
      throw new EmbeddedJsonError(`unknown embedded JSON shape "${shape}": ${source}`, 'not-found');
  }

  const $ = typeof html === 'string' ? load(html) : html;
  const accept = locatorFilter(options.locator);
  const candidates = collect($, new Set(order), maxBytes);

  // A `<script type="application/json">` DECLARES itself to be JSON, so it failing to parse is a
  // real fault worth throwing over. `window.X = {…}` is a guess made by a text scan; on a page with
  // no embedded JSON at all it will still find things (weebcentral.com has
  // `var readingStylesWithPage = ['single_page', …]`, valid JS and not JSON). Reporting that as
  // 'unparseable' would send a provider author hunting a format change that never happened. So a
  // failed guess only becomes a thrown error when the caller asked for that shape by name.
  const guessing = options.shapes === undefined;

  const found: EmbeddedJson[] = [];
  let firstFailure: EmbeddedJsonError | undefined;

  // walk the requested shapes in the caller's order, not document order: the caller asking for
  // ['next-data', 'ld+json'] means "the page state, or failing that the schema.org fallback"
  for (const shape of order) {
    for (const candidate of candidates) {
      if (candidate.shape !== shape || !accept(candidate.locator)) continue;

      let data: unknown;
      try {
        data = parseCandidate(candidate, source, maxBytes);
      } catch (err) {
        // anything that is not one of OUR errors is a fault in this file, not in the page. Letting
        // it be swallowed here would turn it into a bogus 'not-found' — the exact laundering of a
        // real fault into "the site changed" that this module exists to prevent.
        if (!(err instanceof EmbeddedJsonError)) throw err;
        const speculative = guessing && candidate.shape === 'global-assign';
        if (!firstFailure && !speculative) firstFailure = err;
        continue;
      }
      if (options.where && !options.where(data)) continue;

      found.push({ shape: candidate.shape, locator: candidate.locator, data, text: candidate.text });
      if (found.length >= limit) return found;
    }
  }

  // candidates existed but every one of them was broken — that is a format change, not an absence
  if (found.length === 0 && firstFailure) throw firstFailure;
  return found;
}

/** parse one candidate, and put Astro's tuple encoding back into plain values while we are here */
function parseCandidate(candidate: Candidate, source: string, maxBytes: number): unknown {
  if (candidate.text.length > maxBytes)
    throw new EmbeddedJsonError(
      `embedded JSON at ${candidate.locator} is ${candidate.text.length} bytes, over the ${maxBytes} limit: ${source}`,
      'unparseable',
      candidate.locator
    );

  let data: unknown;
  try {
    data = JSON.parse(candidate.text, dropProtoKeys);
  } catch (err) {
    // the usual causes, in order of likelihood: a truncated response; an unescaped `</script>`
    // inside a JSON string, which ends the element early per the HTML parsing spec and leaves a
    // half object behind; or a payload that is JS object syntax (bare keys, single quotes) and
    // never was JSON.
    throw new EmbeddedJsonError(
      `embedded JSON at ${candidate.locator} did not parse (${(err as Error).message}): ${source}`,
      'unparseable',
      candidate.locator
    );
  }

  // Astro props are useless in their wire form — every value is a [typeCode, value] tuple. Decoding
  // here rather than leaving it to the caller is deliberate: a caller who forgets gets silent
  // garbage ("[0, 'Breakers']" where a title belongs), which is the failure this module rejects.
  if (candidate.shape === 'astro-props') {
    try {
      return decodeAstroProps(data, `${candidate.locator}: ${source}`);
    } catch (err) {
      if (err instanceof EmbeddedJsonError) throw err;
      // the decoder walks a tree the remote site shaped, so a pathologically nested payload can
      // exhaust the stack. That is still a bad payload, not a crash to leak upwards.
      throw new EmbeddedJsonError(
        `Astro props at ${candidate.locator} could not be decoded (${(err as Error).message}): ${source}`,
        'unparseable',
        candidate.locator
      );
    }
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * finding candidates
 * ------------------------------------------------------------------ */

function collect($: CheerioAPI, wanted: Set<EmbeddedJsonShape>, maxBytes: number): Candidate[] {
  const out: Candidate[] = [];
  let jsonIndex = 0;
  let ldIndex = 0;

  // cheerio does the two things that make this safe to do with selectors instead of a regex:
  // <script> is a raw-text element, so entities inside it are NOT decoded (a JSON payload
  // containing `&amp;` survives intact), and an unescaped `</script>` terminates the element
  // exactly where a browser would terminate it, so nothing downstream can be spliced in.
  $('script').each((_i, el) => {
    const $el = $(el);
    const id = ($el.attr('id') ?? '').trim();
    const type = ($el.attr('type') ?? '').trim().toLowerCase();
    const text = $el.text();

    if (id === '__NEXT_DATA__') {
      if (wanted.has('next-data')) push(out, 'next-data', 'script#__NEXT_DATA__', text);
      return;
    }
    if (type === 'application/json') {
      // index first so locators stay stable no matter which shapes were requested
      const locator = `script[type="application/json"][${jsonIndex++}]${id ? `#${id}` : ''}`;
      if (wanted.has('json-script')) push(out, 'json-script', locator, text);
      return;
    }
    if (type === 'application/ld+json') {
      const locator = `script[type="application/ld+json"][${ldIndex++}]`;
      if (wanted.has('ld+json')) push(out, 'ld+json', locator, text);
      return;
    }
    if (wanted.has('global-assign') && !$el.attr('src') && EXECUTABLE_SCRIPT_TYPES.has(type))
      collectGlobalAssignments(text, maxBytes, out);
  });

  if (wanted.has('astro-props')) {
    // Astro v5 hydration: `<astro-island props="{&quot;pages&quot;:[1,[…]]}" …>`. The payload lives
    // in an ATTRIBUTE, so it is HTML-entity escaped — `&quot;`, `&amp;`, `&#39;`, `&#x27;`. cheerio
    // returns the attribute already decoded by the parser's full entity table, which is the whole
    // reason this goes through cheerio instead of a hand-written five-entity replace.
    $('astro-island[props]').each((i, el) => {
      const $el = $(el);
      const component = $el.attr('component-url') ?? $el.attr('component-export') ?? $el.attr('uid') ?? '';
      push(out, 'astro-props', `astro-island[${i}][component-url="${component}"]`, $el.attr('props') ?? '');
    });
  }

  return out;
}

/** record a candidate, ignoring blank ones — an empty <script type="application/json"></script> is
 *  an absence, not a parse failure, and must not make an otherwise clean page throw */
function push(out: Candidate[], shape: EmbeddedJsonShape, locator: string, text: string): void {
  const trimmed = text.trim();
  if (trimmed.length > 0) out.push({ shape, locator, text: trimmed });
}

/**
 * `window.__DATA__ = {…}` / `var CurChapter = […]` inside an inline script.
 *
 * The regex only finds the ANCHOR — the left-hand side and the opening brace. The extent of the
 * value is found by {@link sliceJsonValue}, a string-and-escape-aware scanner, because a regex that
 * tries to match balanced braces is exactly the fragile thing this is meant to avoid: it either
 * stops at the first `}` inside a URL or runs to the end of the page.
 *
 * Only strict JSON is accepted. `window.__NUXT__=(function(a,b){…})(…)` and
 * `window.__CF$cv$params={r:'…'}` are found, attempted, and rejected — correctly, since neither is
 * JSON. That rejection is reported, not hidden.
 */
function collectGlobalAssignments(script: string, maxBytes: number, out: Candidate[]): void {
  // built per call: a /g/ regex carries lastIndex, and a module-level one would leak state between
  // scripts (and between calls) the moment the loop below breaks early.
  const anchor = /(?:(window|self|globalThis)\s*\.\s*|(?:var|let|const)\s+)([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?=[{[])/g;
  let hits = 0;
  let match: RegExpExecArray | null;

  while ((match = anchor.exec(script)) !== null) {
    if (++hits > MAX_GLOBAL_ASSIGNMENTS_PER_SCRIPT) return;
    const receiver = match[1];
    const name = match[2];
    const start = match.index + match[0].length; // the lookahead is zero-width: this IS the `{`/`[`
    const value = sliceJsonValue(script, start, maxBytes);
    if (value === undefined) continue; // unterminated — not a value, so not a candidate
    push(out, 'global-assign', receiver ? `${receiver}.${name}` : `var ${name}`, value);
    anchor.lastIndex = start + value.length; // don't re-find assignments nested inside this value
  }
}

/**
 * The `{…}` or `[…]` starting at `start`, or `undefined` if it never closes. String-aware, so a
 * brace inside `"https://cdn/{x}"` does not end it, and escape-aware, so `"\\"` does not swallow
 * the closing quote. Linear in the length scanned and bounded by `maxBytes`.
 */
function sliceJsonValue(text: string, start: number, maxBytes: number): string | undefined {
  const closer = text[start] === '{' ? '}' : ']';
  const limit = Math.min(text.length, start + maxBytes);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < limit; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      if (--depth > 0) continue;
      // depth 0 with a mismatched closer means the braces interleave — malformed either way, and
      // JSON.parse is the authority on that, so hand it the slice and let it say so.
      return ch === closer ? text.slice(start, i + 1) : undefined;
    }
  }
  return undefined;
}

function locatorFilter(want: string | RegExp | undefined): (locator: string) => boolean {
  if (want === undefined) return () => true;
  if (typeof want === 'string') return locator => locator.includes(want);
  // a /g/ or /y/ regex is stateful across .test() calls, which would make the filter skip every
  // other candidate. Strip those flags onto a private copy rather than mutating the caller's.
  const re = want.global || want.sticky ? new RegExp(want.source, want.flags.replace(/[gy]/g, '')) : want;
  return locator => re.test(locator);
}

const describeLocator = (want: string | RegExp): string => (typeof want === 'string' ? JSON.stringify(want) : String(want));

/* ------------------------------------------------------------------ *
 * Astro props
 * ------------------------------------------------------------------ */

/**
 * Undo Astro's island props encoding, in which every value is a `[typeCode, value]` tuple:
 *
 *   {"seriesName":[0,"Breakers"],"pages":[1,[[0,{"url":[0,"https://…webp"],"width":[0,1200]}]]]}
 *   →  { seriesName: 'Breakers', pages: [ { url: 'https://…webp', width: 1200 } ] }
 *
 * The type table is not guessed. It is transcribed from the `astro-island` custom element that
 * Astro inlines into every page it serves (verbatim, from asurascans.com, 2026-08-14):
 *
 *   let i={0:t=>m(t),1:t=>a(t),2:t=>new RegExp(t),3:t=>new Date(t),4:t=>new Map(a(t)),
 *          5:t=>new Set(a(t)),6:t=>BigInt(t),7:t=>new URL(t),8:t=>new Uint8Array(t),
 *          9:t=>new Uint16Array(t),10:t=>new Uint32Array(t),11:t=>1/0*t},
 *       o=t=>{let[l,e]=t;return l in i?i[l](e):void 0},
 *       a=t=>t.map(o),
 *       m=t=>typeof t!="object"||t===null?t:Object.fromEntries(Object.entries(t).map(([l,e])=>[l,o(e)]))
 *
 * Two deliberate differences from that runtime:
 *
 *  - It yields PLAIN DATA. Codes 2–11 (RegExp, Date, Map, Set, BigInt, URL, typed arrays) decode to
 *    their JSON-shaped equivalent — pattern string, ISO string, array of `[k, v]` pairs, array,
 *    digit string, href string, number array — not to the live object Astro would build. In
 *    particular NO RegExp is compiled: a pattern chosen by the remote site is a ReDoS primitive
 *    handed to whatever touches it later, and nothing downstream of a manga provider wants one.
 *    Only codes 0 and 1 have ever been seen on the pages this repo reads; the rest are here so an
 *    unexpected one costs a field rather than the whole chapter.
 *  - An unknown type code THROWS. Astro's own `o` returns `void 0` there, which is precisely the
 *    silent-undefined this module exists to eliminate. The error names the JSON path, so a future
 *    Astro encoding shows up as `props.pages[3].modified` rather than as a missing image.
 *
 * @param props the parsed value of an `<astro-island props="…">` attribute.
 * @param source label used in error messages.
 * @throws {EmbeddedJsonError} `reason: 'unparseable'` on a malformed or unknown tuple.
 */
export function decodeAstroProps(props: unknown, source = '<astro props>'): unknown {
  return reviveValue(props, 'props', source);
}

/** Astro's `m`: the code-0 "Value" branch. Non-objects pass through; object values are tuples. */
function reviveValue(value: unknown, path: string, source: string): unknown {
  if (typeof value !== 'object' || value === null) return value;
  // Faithful to `Object.fromEntries(Object.entries(t)…)`: an array reaching the Value branch comes
  // back index-keyed, exactly as it does in the browser. Astro emits arrays as code 1, so this is
  // a corner that should not arise — but diverging from the page's own result would be worse.
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__') continue;
    out[key] = reviveTuple(entry, `${path}.${key}`, source);
  }
  return out;
}

/** Astro's `o`: `[typeCode, value]` → value. */
function reviveTuple(tuple: unknown, path: string, source: string): unknown {
  if (!Array.isArray(tuple) || tuple.length < 1 || tuple.length > 2)
    throw astroError(`expected an Astro [type, value] tuple at ${path}, got ${describe(tuple)}`, source);

  const code: unknown = tuple[0];
  const value: unknown = tuple[1]; // `[0]` with no second element is Astro's `undefined`

  switch (code) {
    case 0:
      return reviveValue(value, path, source);
    case 1:
      return reviveArray(value, path, source).map((el, i) => reviveTuple(el, `${path}[${i}]`, source));
    case 2: // RegExp — the pattern source, NOT a compiled regex
    case 3: // Date — the serialized string
    case 6: // BigInt — the digits (JSON has no bigint, and BigInt() throws on junk)
    case 7: // URL — the href
      return value;
    case 4: // Map — [key, value] pairs
    case 5: // Set — the members
      return reviveArray(value, path, source).map((el, i) => reviveTuple(el, `${path}[${i}]`, source));
    case 8: // Uint8Array
    case 9: // Uint16Array
    case 10: // Uint32Array — plain number arrays on the wire, not tuples
      return reviveArray(value, path, source).slice();
    case 11: // Infinity, encoded as its sign
      if (typeof value !== 'number')
        throw astroError(`Astro Infinity at ${path} carried ${describe(value)}, expected a sign`, source);
      return value * Infinity;
    default:
      throw astroError(`unknown Astro prop type code ${describe(code)} at ${path}`, source);
  }
}

function reviveArray(value: unknown, path: string, source: string): unknown[] {
  if (!Array.isArray(value)) throw astroError(`expected an array at ${path}, got ${describe(value)}`, source);
  return value;
}

const astroError = (message: string, source: string): EmbeddedJsonError =>
  new EmbeddedJsonError(`${message}: ${source}`, 'unparseable');

/** a short, safe rendering of an untrusted value for an error message */
function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'object' && value !== null) return Array.isArray(value) ? 'an array' : 'an object';
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
