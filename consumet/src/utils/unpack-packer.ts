/**
 * Deterministic expansion of Dean Edwards P.A.C.K.E.R payloads — the one implementation, shared by
 * every provider/extractor that meets the format.
 *
 * WHY THIS EXISTS. Video embed hosts hide their stream URL in a packed script:
 *
 *     eval(function(p,a,c,k,e,d){…}('<payload>',<radix>,<count>,'<a|b|c>'.split('|'),0,{}))
 *
 * The historical way to read it was to `eval()` the page's own script and keep the string it
 * returns. That runs third-party JavaScript with the host process's full privileges — in this repo,
 * inside the API server, next to its env (API_KEY, curl-impersonate paths) and its filesystem and
 * network access. The scraped site controls that text completely, so a compromised or hostile embed
 * host had a direct path to RCE. Worse, the old regex (`/(eval)(\(f.*?)(\n<\/script>)/s`) only
 * required the evaluated expression to start with `f` — it did not have to be a packer at all.
 *
 * The format is deterministic, so nothing needs to be executed: parse the four arguments and redo
 * the base-N token substitution the packer's own runtime does. Pure string work.
 *
 * FIDELITY. In Node, `''.replace(/^/,String)` is `''`, so the packer's runtime takes its dictionary
 * branch: build `d[e(c)] = k[c] || e(c)`, then one pass of `p.replace(/\b\w+\b/g, tok => d[tok])`.
 * That single pass is what is reimplemented here — it never re-scans text it already substituted, so
 * a token that also occurs inside a keyword (common at radix 10, where tokens are digits) cannot
 * corrupt the output. The legacy sequential-regex branch is dead code on any modern engine.
 *
 * FAILURE MODE. Every malformed or unexpected input throws with the caller's context attached. It
 * never returns a partial or empty string: a silent empty result here shows up far downstream as a
 * mystery "no sources found", and this codebase has repeatedly been burned by exactly that.
 */

/** Thrown when a packed payload cannot be read. Carries the caller's source label for diagnosis. */
export class PackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackerError';
  }
}

/** the packer's own `}( '<payload>', <radix>, <count>, '<k|e|y>'.split('|')` invocation */
const ARGS = /\}\s*\(\s*'(.*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*)'\s*\.split\('\|'\)/s;
/** the packer's signature — deliberately exact, so an arbitrary `function(){…}` is not mistaken for one */
const SIGNATURE = /function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)/;

/** undo JS string-literal escaping (\\ \' \" \n \t \r) without evaluating anything */
const unescapeJs = (s: string): string =>
  s.replace(/\\(.)/g, (_m, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch));

/**
 * Expand a P.A.C.K.E.R payload and return the unpacked source **as text**. Nothing is executed.
 *
 * @param input an HTML page, a `<script>` body, or the bare `function(p,a,c,k,e,d){…}(…)` call —
 *              the packer call is located within it. When the input is a page, the search stops at
 *              the `</script>` that closes the packed script, so a second script cannot be spliced
 *              into the first one's arguments.
 * @param source label used in error messages (an embed URL is ideal — it says WHICH host changed).
 * @throws {PackerError} on anything that is not a well-formed packer call.
 */
export function unpackPacker(input: string, source = '<packed script>'): string {
  const start = input.search(SIGNATURE);
  if (start < 0) throw new PackerError(`no P.A.C.K.E.R script found: ${source}`);
  const end = input.indexOf('</script>', start);
  const region = end < 0 ? input.slice(start) : input.slice(start, end);

  // The invocation always ends `…'<payload>',<radix>,<count>,'<w|o|r|d>'.split('|')`. The greedy
  // payload group backtracks to the single `.split('|')` anchor, so quotes/commas/digits inside the
  // payload don't derail it; the `s` flag lets the payload span newlines.
  const args = ARGS.exec(region);
  if (!args) throw new PackerError(`P.A.C.K.E.R call had an unrecognised argument shape: ${source}`);

  const radix = parseInt(args[2], 10);
  const count = parseInt(args[3], 10);
  const words = args[4].split('|');
  if (!Number.isInteger(radix) || radix < 2 || radix > 62)
    throw new PackerError(`P.A.C.K.E.R: invalid radix ${args[2]}: ${source}`);
  if (!Number.isInteger(count) || count < 0 || count > 1_000_000)
    throw new PackerError(`P.A.C.K.E.R: implausible symbol count ${args[3]}: ${source}`);
  if (words.length < count)
    throw new PackerError(
      `P.A.C.K.E.R: keyword table (${words.length}) shorter than declared count (${count}): ${source}`
    );

  const payload = unescapeJs(args[1]);
  // token alphabet, base = radix: 0-9 → '0'-'9', 10-35 → 'a'-'z', 36-61 → 'A'-'Z'
  const encode = (n: number): string => {
    let token = '';
    do {
      const r = n % radix;
      token = (r < 10 ? String(r) : r < 36 ? String.fromCharCode(87 + r) : String.fromCharCode(29 + r)) + token;
      n = Math.floor(n / radix);
    } while (n > 0);
    return token;
  };

  // token→keyword dictionary, then ONE pass over the payload's `\w+` runs. An empty keyword means
  // the token stands for itself (the packer's `k[c] || e(c)`); an unknown token is left alone —
  // the packer itself would write the string "undefined" there, which only destroys evidence.
  const dict = new Map<string, string>();
  for (let i = 0; i < count; i++) dict.set(encode(i), words[i] || encode(i));
  return payload.replace(/\b\w+\b/g, tok => dict.get(tok) ?? tok);
}

/**
 * Evaluate a JavaScript string-concatenation expression — `'a'+'b'+'c'` — without `eval`.
 *
 * Packed scripts sometimes hide a value as a concatenation of literals and the historical way to
 * read it was, again, `eval`. Only quoted literals joined by `+` are accepted; anything else (a
 * function call, an identifier, an operator) throws rather than being executed or guessed at.
 *
 * @throws {PackerError} if the expression is not purely literals joined by `+`.
 */
export function unpackJsStringConcat(expr: string, source = '<string expression>'): string {
  const LITERAL = /^'((?:[^'\\]|\\.)*)'|^"((?:[^"\\]|\\.)*)"/;
  const parts: string[] = [];
  let rest = expr.trim();
  let expectPlus = false;

  while (rest.length > 0) {
    if (expectPlus) {
      if (rest[0] !== '+')
        throw new PackerError(`expected '+' between string literals, found "${rest.slice(0, 24)}": ${source}`);
      rest = rest.slice(1).trimStart();
      expectPlus = false;
      continue;
    }
    const m = LITERAL.exec(rest);
    if (!m) throw new PackerError(`expected a quoted string literal, found "${rest.slice(0, 24)}": ${source}`);
    parts.push(unescapeJs(m[1] ?? m[2]));
    rest = rest.slice(m[0].length).trimStart();
    expectPlus = true;
  }

  if (parts.length === 0) throw new PackerError(`empty string expression: ${source}`);
  // ending on an operand-expecting state means a trailing `+` with nothing after it — a truncated
  // expression, which must be an error rather than a quietly shortened key
  if (!expectPlus) throw new PackerError(`string expression ends with a dangling '+': ${source}`);
  return parts.join('');
}
