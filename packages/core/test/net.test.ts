import { describe, expect, it } from 'vitest'
import { clientIp, trustList } from '../src/net.ts'

describe('clientIp', () => {
  const trusted = trustList('10.0.0.0/8, ::1')
  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(clientIp('203.0.113.9', '1.2.3.4', trusted)).toBe('203.0.113.9')
  })
  it('takes the rightmost untrusted hop behind trusted proxies', () => {
    expect(clientIp('::ffff:10.0.0.2', '6.6.6.6, 1.2.3.4, 10.0.0.7', trusted)).toBe('1.2.3.4')
    expect(clientIp('::1', '1.2.3.4', trusted)).toBe('1.2.3.4')
  })
  it('falls back to the peer when the header is missing or junk', () => {
    expect(clientIp('10.0.0.2', null, trusted)).toBe('10.0.0.2')
    expect(clientIp('10.0.0.2', 'garbage', trusted)).toBe('10.0.0.2')
  })
})
