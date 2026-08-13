// SSRF guard for the /proxy route.
//
// /proxy fetches an attacker-supplied URL and streams the body back, unauthenticated (proxy URLs
// are embedded in rewritten HLS playlists the video player fetches directly, so the route can't be
// API-key gated). Without this guard, `?url=http://169.254.169.254/...` reaches cloud instance
// metadata (credential theft), and `?url=http://127.0.0.1:4000/` / internal Docker service names
// reach anything on the private network. This is the same vulnerability class the MAIN SITE repo
// already closed with its own `ssrf-guard`; this proxy is a separate codebase that never got it.
//
// Approach (mirrors that guard):
//   1. Only http/https schemes.
//   2. Resolve the host to IP(s) and reject if ANY resolved address — or a literal-IP host — falls
//      in a private / loopback / link-local / metadata / reserved range (IPv4 and IPv6, including
//      IPv4-mapped and NAT64 forms that embed a v4 address).
//   3. Re-validate after EVERY redirect hop, not just the initial URL — the redirect-follow is part
//      of the exploit path (a public URL that 302s to 169.254.169.254 would otherwise sail through).
//
// Residual risk (documented, not silently ignored): DNS rebinding — the address this guard resolves
// and the address the subsequent fetch connects to are resolved independently, so a hostile resolver
// could return a public IP here and a private IP to the fetch. Fully closing that needs connection-
// level IP pinning (a custom undici dispatcher). Not done here to avoid re-plumbing the streaming
// path; called out in TASKS reporting. The literal-IP and redirect vectors — the ones actually
// reachable with `?url=` today — are closed.

import net from 'node:net';
import dns from 'node:dns/promises';

/** Thrown when a URL is rejected as unsafe to proxy. Callers map this to a 400. */
export class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
  }
}

// Non-public ranges, expressed once and loaded into a battle-tested net.BlockList (handles the
// bit-masking for us). IPv4 and IPv6 kept separate because BlockList.check() is type-scoped.
const blocklist = new net.BlockList();
// -- IPv4 --
blocklist.addSubnet('0.0.0.0', 8, 'ipv4'); // "this host" / 0.0.0.0
blocklist.addSubnet('10.0.0.0', 8, 'ipv4'); // RFC1918 private
blocklist.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
blocklist.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
blocklist.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local — CLOUD INSTANCE METADATA lives here
blocklist.addSubnet('172.16.0.0', 12, 'ipv4'); // RFC1918 private
blocklist.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
blocklist.addSubnet('192.0.2.0', 24, 'ipv4'); // TEST-NET-1
blocklist.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC1918 private
blocklist.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
blocklist.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2
blocklist.addSubnet('203.0.113.0', 24, 'ipv4'); // TEST-NET-3
blocklist.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
blocklist.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved (incl. 255.255.255.255 broadcast)
// -- IPv6 --
blocklist.addAddress('::1', 'ipv6'); // loopback
blocklist.addAddress('::', 'ipv6'); // unspecified
blocklist.addSubnet('fc00::', 7, 'ipv6'); // unique-local (incl. AWS fd00:ec2::254 IMDS)
blocklist.addSubnet('fe80::', 10, 'ipv6'); // link-local
blocklist.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64 (embeds a v4 address)
blocklist.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
blocklist.addSubnet('100::', 64, 'ipv6'); // discard-only
// NOTE: we deliberately do NOT add ::ffff:0:0/96 — net.BlockList normalizes IPv4 to its IPv4-mapped
// form internally, so that subnet would match EVERY IPv4 address and block all public traffic.
// Instead, check() below is given an IPv4-mapped IPv6 literal (dotted OR hex form) and BlockList
// resolves it against the IPv4 rules automatically, so e.g. ::ffff:169.254.169.254 is still caught.

/**
 * True if `ip` (a literal IPv4 or IPv6 string) is in any blocked range. Anything that isn't a valid
 * IP is treated as blocked — callers should only pass strings that already parsed as IPs.
 */
export function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return blocklist.check(ip, 'ipv4');
  // For IPv6, check() also resolves IPv4-mapped addresses (::ffff:a.b.c.d / ::ffff:hhhh:hhhh)
  // against the IPv4 rules, so mapped-address evasions are covered here too.
  if (family === 6) return blocklist.check(ip, 'ipv6');
  return true; // not a parseable IP
}

/**
 * Validate that `urlString` is safe to fetch server-side. Resolves the host and checks every
 * resulting address. Throws {@link SsrfError} on any violation; resolves to the array of vetted IP
 * strings on success (useful for connection pinning if a caller wants it).
 */
export async function assertUrlSafe(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new SsrfError('malformed url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfError(`scheme "${u.protocol}" not allowed (http/https only)`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!host) throw new SsrfError('empty host');

  // Literal IP host: check directly, skip DNS.
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`host ${host} is in a blocked (private/loopback/metadata) range`);
    return [host];
  }

  // Hostname: resolve ALL records and reject if any is private — a hostname that resolves to both a
  // public and a private address must not slip through on the public one.
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfError(`could not resolve host ${host}`);
  }
  if (!addrs.length) throw new SsrfError(`host ${host} resolved to no addresses`);
  for (const { address } of addrs) {
    if (isBlockedIp(address)) {
      throw new SsrfError(`host ${host} resolves to ${address}, which is in a blocked range`);
    }
  }
  return addrs.map(a => a.address);
}

/**
 * Fetch `initialUrl`, following redirects MANUALLY and re-validating each hop with
 * {@link assertUrlSafe} before following it. `initialUrl` is assumed already vetted by the caller
 * (the /proxy handler validates it up front to return a clean 400); this closes the redirect vector.
 *
 * `fetchImpl` is injectable so the redirect re-validation can be unit-tested without real sockets.
 */
export async function followSafeRedirects(
  initialUrl,
  fetchOpts = {},
  { fetchImpl = fetch, maxRedirects = 5 } = {}
) {
  let url = initialUrl;
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(url, { ...fetchOpts, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res; // 3xx without a Location — nothing to follow
      if (hop >= maxRedirects) throw new SsrfError(`exceeded ${maxRedirects} redirects while proxying ${initialUrl}`);
      const next = new URL(loc, url).href;
      await assertUrlSafe(next); // ← re-validate BEFORE following the redirect
      try {
        await res.body?.cancel?.(); // release the socket for the abandoned hop
      } catch {}
      url = next;
      continue;
    }
    return res;
  }
}
