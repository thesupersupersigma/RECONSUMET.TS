// SSRF guard for untrusted URLs (the 0.4 proxy fetches URLs found in third-party playlists).
// Based on v1's audited api/src/ssrf-guard.mjs, plus: the address that was checked is the one connected to
// (plain tier: a validating DNS lookup inside the connection; impersonate tier: a pinned `resolve` map), so there
// is no DNS-rebinding gap; 6to4/Teredo/multicast/IPv4-compatible ranges are blocked too.

import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { SsrfError } from './errors.ts'
import type { LookupFn } from './types.ts'

const blocklist = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT, also Tailscale's range (tsss-server!) and Alibaba metadata 100.100.100.200
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF assignments (incl. Oracle metadata 192.0.0.192)
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blocklist.addSubnet(net, bits, 'ipv4')
}
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback, deprecated IPv4-compatible
  ['fc00::', 7], // unique-local (incl. AWS IMDS fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['64:ff9b::', 96], // NAT64 (embeds IPv4)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['2001::', 32], // Teredo (embeds IPv4)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['100::', 64], // discard-only
] as const) {
  blocklist.addSubnet(net, bits, 'ipv6')
}
// Not adding ::ffff:0:0/96: BlockList stores IPv4 rules in mapped form, so that subnet would match every IPv4
// address. check() already tests ::ffff:a.b.c.d against the IPv4 rules above.

/** Test hook only (not exported from the package): addresses here pass, so tests can use a 127.0.0.1 server. */
export const allowForTests = new Set<string>()

/** True if `ip` is in a blocked range. Anything that isn't an IP counts as blocked. */
export function isBlockedIp(ip: string): boolean {
  if (allowForTests.has(ip)) return false
  const family = isIP(ip)
  if (family === 4) return blocklist.check(ip, 'ipv4')
  if (family === 6) return blocklist.check(ip, 'ipv6')
  return true
}

/** Scheme + literal-IP checks that need no DNS. Returns the bare hostname (no IPv6 brackets). */
export function checkUrl(url: URL): string {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`scheme ${url.protocol} not allowed (http/https only)`, url.href)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new SsrfError('empty host', url.href)
  if (isIP(host) && isBlockedIp(host)) throw new SsrfError(`${host} is in a blocked range`, url.href)
  return host
}

export const defaultLookup: LookupFn = (hostname, options) => dnsLookup(hostname, { ...options, verbatim: true })

/** Resolve every address of `host` and refuse if any one is blocked (a public + private answer must not slip through). */
export async function resolveSafe(host: string, url: string, lookup: LookupFn = defaultLookup): Promise<string[]> {
  if (isIP(host)) return [host] // checkUrl already vetted literals
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch (e) {
    throw new SsrfError(`could not resolve ${host}`, url, { cause: e })
  }
  if (!addrs.length) throw new SsrfError(`${host} resolved to no addresses`, url)
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new SsrfError(`${host} resolves to ${address}, which is in a blocked range`, url)
  }
  return addrs.map((a) => a.address)
}

type LookupCallback = (
  err: Error | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void

/**
 * A `net.connect` lookup for undici's `connect.lookup`. With `validate`, it refuses blocked addresses, and the
 * socket connects to exactly the address checked here.
 */
export function connectLookup(lookup: LookupFn, validate: boolean) {
  return (hostname: string, options: { all?: boolean }, cb: LookupCallback) => {
    const resolved = validate
      ? resolveSafe(hostname, hostname, lookup)
      : lookup(hostname, { all: true }).then((a) => a.map((x) => x.address))
    resolved.then(
      (addrs) => {
        const list = addrs.map((address) => ({ address, family: isIP(address) }))
        if (options?.all) cb(null, list)
        else cb(null, list[0]!.address, list[0]!.family)
      },
      (e: Error) => cb(e, ''),
    )
  }
}
