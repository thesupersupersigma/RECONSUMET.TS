// Shared request-value validators for the anime-api routes.
//
// WHY THIS MODULE EXISTS. Three of these used to be copy-pasted between src/server.mjs and
// src/manga-routes.mjs, each with a comment reading "duplicated deliberately; if you change one,
// change the other". That convention held for exactly as long as there were two of them. It then
// failed in the way copy-pasted validators always fail: /manga/image grew an http(s) scheme check
// on its `ref` and /proxy — the older, far more heavily used route, whose `ref` reaches upstream
// through TWO different transports — never got one. A divergence that nobody noticed is the whole
// argument for a single definition, so `isSingle`, `isNumericId` and the header-value validators
// now live here and both route modules import them. The cross-referencing "change one, change the
// other" comments are gone with the copies they described.
//
// WHAT THE HEADER VALIDATORS ARE ACTUALLY FOR — read this before hardening them further, because
// the threat model was measured, not assumed (probe: a stand-in curl binary that dumps its argv,
// now committed as test/fixtures/fake-curl.mjs, plus a loopback listener echoing rawHeaders):
//
//   * A user-supplied value landing in an outbound header CANNOT inject a second header on either
//     transport. On the plain-fetch path undici REJECTS a CR/LF-bearing value outright (TypeError
//     out of Headers.append, which /proxy already turns into a 502). On the curl-impersonate path
//     the value is one element of an argv array handed to spawn() with no shell, so `-H` and its
//     `${k}: ${v}` string cannot be split by anything the value contains.
//   * A colon inside a header VALUE is legal. `Referer: https://a.example/X-Injected: pwned` is one
//     header line with an odd value; the loopback listener sees exactly one `Referer` and zero
//     `X-Injected`. Do not describe rejecting it as closing an injection hole — it is not one.
//   * Re-confirmed independently on the WIRE, not just in argv: /proxy was driven against a raw
//     TCP listener (no HTTP parser to hide a smuggled header) with CURL_IMPERSONATE_BIN pointed at
//     a real curl 8.7.1, across CRLF / bare CR / bare LF / %0d%0a / %250d%250a / leading SP / leading
//     TAB / NUL / U+2028 / U+2029 on all three of ref, org and km. Every request that reached
//     upstream carried exactly one of each header name and zero injected headers.
//
// THE TWO TRANSPORTS ARE NOT EQUALLY STRICT, which is the real reason to validate at the boundary
// rather than lean on either of them. undici enforces the ByteString rule and throws; spawn()
// enforces nothing and encodes argv as UTF-8. Anything accepted here is sent by BOTH, so this
// module has to be at least as strict as the stricter transport — see hasNonByteChar.
//
// So these validators are shape enforcement and defence in depth, not a fix for a live injection.
// What they do buy, concretely: `javascript:`/`data:`/`file:`/scheme-less values stop becoming a
// Referer (and stop becoming `Origin: null` upstream — see impersonatedFetch, which derives the
// Origin from the referer when the caller supplies none), an `Origin` stops being able to carry a
// path, and every one of them is now rejected at the boundary with a 400 instead of being sent.
//
// REJECT, DO NOT SANITISE. `new URL()` silently DELETES tab/CR/LF from its input per the WHATWG
// parser — `new URL('https://a\r\nX')` is `https://ax/`, no throw — so a URL parse is not a CRLF
// check and "strip, then validate" is order-dependent by construction. Everything below tests for
// control characters explicitly, before parsing.

/**
 * A REPEATED query param (`?x=a&x=b`) arrives from Fastify's querystring parser as an ARRAY, not a
 * string. Every guard in both route modules is written as a string test — `typeof v === 'string'`,
 * `v.startsWith(...)`, a regex — so an array either skips its guard entirely or gets silently
 * stringified with a comma past it. This is a property of the PARSER, not of any one param, so
 * every user-controlled query value is checked with this before it is used.
 */
export const isSingle = v => v === undefined || typeof v === 'string';

/** AniList ids (anime and manga alike) are decimal integers and nothing else. */
export const isNumericId = v => /^\d+$/.test(String(v ?? ''));

/**
 * Strip CR/LF from a value destined for an outbound request header.
 *
 * PREFER REJECTING (the validators below) TO STRIPPING. This is retained for /manga/image, whose
 * strip-then-validate order is pinned by an existing test, and it is the weaker of the two: it
 * turns `https://a/\r\nX-Injected: y` into the perfectly valid-looking `https://a/X-Injected: y`
 * and lets it through, where /proxy now answers 400 on the raw value. Neither is exploitable (see
 * the header), but only one of them tells the caller their input was wrong.
 */
export const headerSafe = v => (typeof v === 'string' ? v.replace(/[\r\n]/g, '') : v);

/** C0 controls + DEL: never legal in a URL, and CR/LF/NUL are the framing-relevant ones. */
const hasControlChar = v => /[\x00-\x1f\x7f]/.test(v);

/**
 * A code unit above U+00FF cannot be a header value. An HTTP header value is a ByteString, so
 * undici's Headers.append THROWS on anything > 0xFF ("Cannot convert argument to a ByteString").
 *
 * WHY THIS IS A SEPARATE CHECK FROM hasControlChar, AND WHY IT MATTERS. It is the one input that
 * made the two /proxy transports DISAGREE, measured on the wire (real curl 8.7.1 -> a raw-socket
 * listener that records bytes with no HTTP parser in the way):
 *   ref=https://a.example/<U+2028>X-Injected: pwned
 *     plain-fetch path      -> 502, undici refused the value
 *     curl-impersonate path -> 200, and `Referer: https://a.example/\xe2\x80\xa8X-Injected: pwned`
 *                              went upstream as raw UTF-8 bytes (spawn() encodes argv as UTF-8;
 *                              there is no ByteString gate on that path at all)
 * Neither is an injection — the capture shows ONE Referer line and no CR/LF — but "a value one
 * transport refuses and the other sends" is precisely the divergence these validators exist to
 * end, and a 400 is the honest answer to both. U+2028/U+2029 are the interesting cases because
 * they are line terminators to a JS parser while being neither C0 controls nor DEL.
 *
 * Bounded at 0xFF rather than at ASCII on purpose: a Latin-1 character (é) IS a legal ByteString
 * and undici sends it today, so rejecting it here would be a behaviour change rather than a
 * convergence. This rejects exactly what the stricter transport already rejects, no more.
 */
const hasNonByteChar = v => /[^\x00-\xff]/.test(v);

/**
 * An absolute http(s) URL, suitable as a `Referer`. Checked for control characters BEFORE parsing
 * (see REJECT, DO NOT SANITISE above). Stricter than the `/^https?:\/\//i` regex it replaces on
 * /manga/image: `https://` and `http://[nonsense` pass that regex and fail this.
 *
 * Deliberately does NOT reject spaces or other odd-but-encodable path characters. They are legal
 * in a header value, they cannot inject anything, and /manga/image has a committed test that pins
 * `https://mangapill.com/X-Injected: yes` (the stripped form of a CRLF probe) as accepted.
 */
export const isRefererUrl = v => {
  if (typeof v !== 'string' || v === '' || hasControlChar(v) || hasNonByteChar(v)) return false;
  let u;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return u.protocol === 'http:' || u.protocol === 'https:';
};

/**
 * Validate a caller-supplied `Origin` and return it in its canonical serialized form, or null.
 *
 * AN ORIGIN IS NOT A URL. It is a serialized origin — scheme, host and optional non-default port,
 * and NOTHING else: no path, no query, no fragment, no userinfo. `https://a.example/segments/` is
 * a fine Referer and a malformed Origin, so this is stricter than isRefererUrl rather than a copy
 * of it. The one Origin this codebase actually produces is KickAssAnime's `https://krussdomi.com`
 * (consumet/src/providers/anime/kaa.ts), which is already in exactly this form.
 *
 * Returns `u.origin` rather than the input, so `https://a.example/` (a trailing slash is the one
 * bit of slop worth tolerating — a caller hand-building a link will write it) is normalised to
 * `https://a.example` instead of being sent as-is or rejected.
 */
export const originHeaderValue = v => {
  if (!isRefererUrl(v) || /\s/.test(v)) return null;
  const u = new URL(v);
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  return u.origin;
};

/**
 * A single opaque token safe to use as a header value: printable ASCII, no spaces, no controls,
 * bounded length. Used for /proxy's `km`, which becomes the `x-am-media-id` header (UniqueStream's
 * `media_id`, a compact id — see deriveUniqueStreamKey). Deliberately shape-based rather than
 * format-based: we do not control the id's format and must not guess it, but nothing legitimate
 * needs a space, a control character or a kilobyte.
 */
export const isHeaderToken = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && /^[\x21-\x7e]+$/.test(v);
