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
// It happened a SECOND time, exactly as predicted, with the public-origin helper: server.mjs's
// `proxyBase()` and manga-routes.mjs's `publicBase()` were byte-identical copies under a comment
// reading "same derivation server.mjs's proxyBase() uses". Both trusted `req.headers.host`. Fixing
// one would have left the other open, so `resolvePublicBaseEnv` at the bottom of this file is now
// the single definition of "what origin is this server allowed to put in a link".
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

// =================================================================================================
// THE PUBLIC BASE — the origin this server is allowed to put inside a link it mints.
// =================================================================================================
//
// WHAT WAS WRONG. Both route modules built links as
//     process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`
// so with PUBLIC_URL unset every generated URL was a verbatim echo of a CLIENT-SUPPLIED header.
// Measured against the real routes plugin (probe: raw http.request with a forged Host):
//     Host: evil.attacker.example        -> pages[].img = http://evil.attacker.example/manga/image?...
//     Host: evil.attacker.example:8443   -> ...:8443/manga/image?...   (ports ride along)
//     Host: [::1]:9999                   -> http://[::1]:9999/...      (IPv6 rides along)
// The same helper feeds the /watch source wrapper and the HLS playlist rewrite, so a forged Host
// also redirects every segment, key and sub-playlist URI in a rewritten m3u8. `/manga/read` answers
// carry a provider-chosen `Cache-Control` — up to a year, `immutable`, for content-addressed CDNs —
// so a shared cache keyed on the URL and not on Host turns this from "the attacker poisons their
// own response" into "the attacker poisons everyone's".
//
// `req.protocol` IS ALSO CLIENT-CONTROLLED, and the brief did not mention it. server.mjs runs
// Fastify with `trustProxy: ['loopback','linklocal','uniquelocal']` and Fastify then reads
// `req.protocol` straight out of `X-Forwarded-Proto` WITHOUT VALIDATING IT. Measured on that exact
// config: `X-Forwarded-Proto: gopher` from a loopback peer yields `req.protocol === 'gopher'`, i.e.
// `gopher://host/proxy?...`. Any caller inside the trusted ranges (loopback, link-local, private —
// in production that is our own Docker network) can therefore pick the SCHEME too.
//
// WHAT IS *NOT* WRONG, measured, so nobody re-hardens the wrong thing: `X-Forwarded-Host` does NOT
// reach this code. Fastify folds it into `req.hostname`, and both helpers read `req.headers.host`,
// which stays the on-the-wire Host. Sending `X-Forwarded-Host: evil2.attacker.example` changed
// nothing in the probe above. The fix below never reads either forwarded header.
//
// THE RULE, AND WHY IT IS THIS ONE. The set of origins this server may emit is now ENUMERATED IN
// CONFIG. A request header can only ever SELECT among origins an operator already wrote down; it
// can never contribute a byte to one. That is the difference between an allowlist and sanitising a
// header, and it is why no amount of Host/port/IPv6/userinfo cleverness in the header matters here.
//
// Rejected alternatives, in the order the brief lists them:
//
//   * "Require PUBLIC_URL, fail at startup if unset." Safest and simplest, and genuinely tempting.
//     Rejected because the cost is real and avoidable: README.md documents the default as "derived
//     from request", and every offline harness in api/test — manga-wired, manga-image, manga-routes,
//     server-ssrf, server-repeated-params — spawns a server on 127.0.0.1 with no PUBLIC_URL. Two of
//     them set `PUBLIC_URL: ''` *deliberately*, one with the comment "which is what the deployed
//     default does when PUBLIC_URL is not configured", and assert request-derived same-origin links.
//     A hard startup requirement breaks `node src/server.mjs` for a developer as well. The loopback
//     escape hatch below buys all of that back while giving up nothing in production (see WHY THE
//     DEV FALLBACK CANNOT FIRE IN PRODUCTION).
//
//   * "Trust a forwarded header when a trusted-proxy setting says so." Rejected outright. This
//     codebase already has the scar: see RL_TRUST_PROXY in server.mjs, where `trustProxy: true`
//     let any client forge `X-Forwarded-For` and mint a fresh rate-limit bucket per request. The
//     sibling site repo has the same bug in its live form. A trusted-proxy setting is a promise
//     about network topology that nothing in the process can verify, and it is wrong by default on
//     every machine that is not the one deployment it was written for. An allowlist of origins is
//     a promise about OUR OWN NAMES, which we do know. Note the measurement above: Fastify's
//     `req.protocol` is exactly this trap already sprung — an unvalidated forwarded header, trusted
//     because a setting said a peer range was fine. Nothing below reads `req.protocol`.
//
// WHY THE DEV FALLBACK CANNOT FIRE IN PRODUCTION. With NEITHER `PUBLIC_URL` nor
// `PUBLIC_URL_ALLOWED_ORIGINS` set, a base is derived from the request only when BOTH hold:
//   1. the `Host` header names a loopback interface (`localhost`, `127.0.0.0/8`, `[::1]`), AND
//   2. the RAW SOCKET PEER is a loopback address — `req.socket.remoteAddress`, not `req.ip`.
// (2) is the load-bearing half and it is deliberately NOT `req.ip`: `req.ip` is trustProxy-derived
// and therefore XFF-influenced, i.e. the very thing being distrusted. The socket peer is observed
// by the kernel and cannot be forged by any header. In the deployment described by SETUP.md the
// peer is Traefik on the private Docker network (172.16/12 — private, not loopback), and for a
// directly-exposed process it is the client's public IP; in both cases (2) is false and the
// fallback is unreachable, so the only way to reach it is to be on the box talking to 127.0.0.1.
// Both halves are also required at once, so `Host: 127.0.0.1` from a remote peer does not qualify.
// SETUP.md already sets PUBLIC_URL in production, so production never depended on any of this.
//
// EVERYTHING ELSE FAILS LOUDLY. No silent root-relative downgrade: a relative `sources[].url` would
// quietly break the cross-origin frontend (the site is thesupersuperanime.lol, the API is
// api.thesupersuperanime.lol), which is precisely the "quietly wrong but safe" failure the fix is
// forbidden to introduce. Startup dies with the variable to set; a live request that cannot resolve
// a base logs and answers 500 naming it.

/** Thrown by everything below. Route handlers turn it into a 500 whose body is `.message`. */
export class PublicBaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicBaseError';
  }
}

/**
 * Parse ONE configured base URL into the string that gets prefixed onto `/proxy?...`.
 *
 * Accepts `scheme://host[:port][/path]`, http(s) only, and strips trailing slashes so
 * `https://a.example/` cannot produce `https://a.example//proxy`. A path prefix is kept (someone
 * mounting behind `https://a.example/api` is legitimate). Userinfo, query and fragment are
 * REJECTED rather than dropped — they mean the operator wrote something they did not intend, and
 * silently repairing config is how a wrong origin ships.
 *
 * Returns null for empty/unset (the caller decides whether that is fatal), else
 * `{ base, host, protocol }` where `host` is the canonical `host[:port]` with the default port for
 * the scheme already removed — the form `matchesHostHeader` compares against.
 */
export const parsePublicBase = (raw, label = 'PUBLIC_URL') => {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return null;
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new PublicBaseError(`${label} is not an absolute URL: ${JSON.stringify(v)} (expected e.g. https://api.example.com)`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new PublicBaseError(`${label} must be http:// or https://, got ${JSON.stringify(u.protocol)}`);
  if (!u.hostname) throw new PublicBaseError(`${label} has no host: ${JSON.stringify(v)}`);
  if (u.username || u.password) throw new PublicBaseError(`${label} must not contain credentials: ${JSON.stringify(v)}`);
  if (u.search || u.hash) throw new PublicBaseError(`${label} must not contain a query or fragment: ${JSON.stringify(v)}`);
  return { base: `${u.origin}${u.pathname}`.replace(/\/+$/, ''), host: u.host, protocol: u.protocol };
};

/** Parse a comma-separated list of base URLs. Empty/unset → []. Each entry validated as above. */
export const parsePublicBaseList = (raw, label = 'PUBLIC_URL_ALLOWED_ORIGINS') =>
  (typeof raw === 'string' ? raw : '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => parsePublicBase(s, label));

/**
 * Canonicalise a raw `Host` header to `host[:port]`, INTERPRETED UNDER `protocol` so the scheme's
 * default port is dropped the same way `new URL().host` drops it in a configured origin. That is
 * what makes `Host: a.example:443` match a configured `https://a.example`, and — deliberately —
 * what stops it matching a configured `http://a.example`.
 *
 * Returns null unless the value is a BARE host. The rejections are the point, because "host" is a
 * much smaller grammar than "URL" and every extra thing a URL can carry is a way to smuggle a
 * different origin past a naive comparison:
 *   - non-printable / non-ASCII bytes (a Host header is ASCII; IDN arrives as punycode)
 *   - `/ \ ? #` — path, query and fragment markers, so `Host: a.example/../evil` cannot parse to
 *     host `a.example` and quietly bring a path along
 *   - `@` — userinfo, so `Host: trusted.example@evil.example` cannot be read as host
 *     `trusted.example` by a human and `evil.example` by the parser
 * Everything left is re-checked after parsing (no userinfo, no path, no query, no fragment) rather
 * than trusted to the pre-filter, because the WHATWG parser deletes some characters instead of
 * throwing — see REJECT, DO NOT SANITISE above.
 */
export const normaliseHostHeader = (rawHost, protocol = 'http:') => {
  if (typeof rawHost !== 'string' || rawHost === '' || rawHost.length > 255) return null;
  if (/[^\x21-\x7e]/.test(rawHost)) return null;
  if (/[/\\?#@]/.test(rawHost)) return null;
  let u;
  try {
    u = new URL(`${protocol}//${rawHost}`);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  return u.host || null;
};

/** True when the raw `Host` header names a loopback interface. IPv6 arrives bracketed from URL. */
export const isLoopbackHostHeader = rawHost => {
  const host = normaliseHostHeader(rawHost, 'http:');
  if (!host) return false;
  const hostname = new URL(`http://${host}`).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
};

/**
 * True when a raw socket address is loopback. Node reports an IPv4 peer on a dual-stack listener as
 * `::ffff:127.0.0.1`, which is why the mapped prefix is stripped before testing.
 */
export const isLoopbackAddress = addr => {
  if (typeof addr !== 'string' || !addr) return false;
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
};

/**
 * Build the per-request base resolver. `publicUrl` is the default; `allowedOrigins` (already parsed)
 * are additional origins a request's Host may select between, for a multi-name deployment.
 *
 * Resolution order — note that at no point is any part of a request header COPIED into the result:
 *   1. an allowlisted origin whose host the request's Host header matches → that CONFIGURED origin
 *   2. `publicUrl`, if set → that configured origin, whatever the Host said
 *   3. the loopback dev fallback (both halves required; see the header) → `http://<loopback host>`
 *   4. throw PublicBaseError
 * The one string built from a header is (3), and it is a loopback literal by construction.
 */
export const createPublicBase = ({ publicUrl = null, allowedOrigins = [], envName = 'PUBLIC_URL' } = {}) => req => {
  const rawHost = req?.headers?.host;
  for (const cand of allowedOrigins) {
    if (normaliseHostHeader(rawHost, cand.protocol) === cand.host) return cand.base;
  }
  if (publicUrl) return publicUrl.base;
  // The request's Host is deliberately NOT quoted back in either message. It is attacker-controlled
  // and these bodies are returned to the caller; the whole point of this module is that a header
  // does not get to choose what we emit, and that includes emitting it inside an error string. The
  // handlers log it (`{ err, host }`) where the operator who needs it can see it.
  if (allowedOrigins.length)
    throw new PublicBaseError(
      `cannot build an absolute link: this request's Host is not in PUBLIC_URL_ALLOWED_ORIGINS and ` +
        `${envName} is unset. Set ${envName} to this deployment's public origin, e.g. ` +
        `${envName}=https://api.example.com, as the default for unmatched hosts.`
    );
  if (isLoopbackHostHeader(rawHost) && isLoopbackAddress(req?.socket?.remoteAddress))
    return `http://${normaliseHostHeader(rawHost, 'http:')}`;
  throw new PublicBaseError(
    `cannot build an absolute link: ${envName} is not set and this request is not local. ` +
      `Set ${envName} to this deployment's public origin, e.g. ${envName}=https://api.example.com`
  );
};

/**
 * Read the base config out of an env bag ONCE, at module load, and never throw while doing it.
 *
 * The non-throwing contract is deliberate: server.mjs and manga-routes.mjs both need this, ESM
 * evaluates manga-routes.mjs BEFORE server.mjs's own top-level code, so a throw at import time
 * would escape server.mjs's startup handler and surface as a raw stack trace instead of the
 * one-line "set PUBLIC_URL=..." message that makes a misconfiguration self-explaining. Callers get
 * `{ resolve, error, publicUrl, allowedOrigins }` and are expected to check `error` at startup.
 */
export const resolvePublicBaseEnv = (env = process.env) => {
  let publicUrl = null;
  let allowedOrigins = [];
  let error = null;
  try {
    publicUrl = parsePublicBase(env.PUBLIC_URL, 'PUBLIC_URL');
    allowedOrigins = parsePublicBaseList(env.PUBLIC_URL_ALLOWED_ORIGINS, 'PUBLIC_URL_ALLOWED_ORIGINS');
  } catch (e) {
    error = e;
  }
  const resolve = error
    ? () => {
        throw error;
      }
    : createPublicBase({ publicUrl, allowedOrigins });
  return { resolve, error, publicUrl, allowedOrigins };
};
