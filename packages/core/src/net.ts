// The client's IP behind reverse proxies: X-Forwarded-For (or a single-IP header like CF-Connecting-IP) is only
// believed when the direct peer is a trusted proxy.
import { BlockList, isIP } from 'node:net'

/** TRUSTED_PROXIES-style list ("10.0.0.0/8, 172.16.0.0/12, ::1") → a BlockList. */
export function trustList(spec: string | string[] | undefined): BlockList {
  const list = new BlockList()
  for (const raw of Array.isArray(spec) ? spec : (spec ?? '').split(',')) {
    const [addr = '', bits] = raw.trim().split('/')
    const family = isIP(addr)
    if (!family) continue
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (bits) list.addSubnet(addr, Number(bits), type)
    else list.addAddress(addr, type)
  }
  return list
}

const bare = (ip: string) => ip.trim().replace(/^::ffff:(?=\d+\.)/, '')
const isTrusted = (list: BlockList, ip: string) => {
  const family = isIP(ip)
  return family !== 0 && list.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

/** Rightmost X-Forwarded-For hop that isn't a trusted proxy; the socket address when the peer isn't trusted. */
export function clientIp(remote: string, forwardedFor: string | null | undefined, trusted: BlockList): string {
  let ip = bare(remote)
  if (!forwardedFor || !isTrusted(trusted, ip)) return ip
  const hops = forwardedFor
    .split(',')
    .map(bare)
    .filter((h) => isIP(h))
  while (hops.length) {
    ip = hops.pop() as string
    if (!isTrusted(trusted, ip)) return ip
  }
  return ip
}
