import { describe, expect, it } from 'vitest'
import { SsrfError } from '../src/fetch/errors.ts'
import { checkUrl, isBlockedIp, resolveSafe } from '../src/fetch/ssrf.ts'

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.7',
    '172.16.5.4',
    '192.168.1.1',
    '100.64.0.1',
    '100.100.1.2', // CGNAT, the range Tailscale addresses come from
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '255.255.255.255',
    '::1',
    '::',
    'fd00:ec2::254', // AWS IMDS over IPv6
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped
    '::ffff:a9fe:a9fe', // IPv4-mapped, hex form of 169.254.169.254
    '64:ff9b::a9fe:a9fe', // NAT64
    '2002:7f00:1::1', // 6to4 of 127.0.0.1
    '2001:0:4136:e378::1', // Teredo
    'not-an-ip',
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true))

  it.each(['8.8.8.8', '104.16.1.1', '2606:4700::1111', '2a00:1450:4001::64'])('allows %s', (ip) =>
    expect(isBlockedIp(ip)).toBe(false),
  )
})

describe('checkUrl / resolveSafe', () => {
  it('refuses non-http schemes and private literals', () => {
    expect(() => checkUrl(new URL('file:///etc/passwd'))).toThrow(SsrfError)
    expect(() => checkUrl(new URL('http://169.254.169.254/latest/meta-data/'))).toThrow(SsrfError)
    expect(() => checkUrl(new URL('http://[::1]:8080/'))).toThrow(SsrfError)
    expect(checkUrl(new URL('https://example.com/x'))).toBe('example.com')
  })

  it('refuses a name if ANY of its addresses is private', async () => {
    const lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ]
    await expect(resolveSafe('mixed.test', 'http://mixed.test/', lookup)).rejects.toThrow(SsrfError)
  })

  it('returns the vetted addresses', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
    await expect(resolveSafe('ok.test', 'http://ok.test/', lookup)).resolves.toEqual(['93.184.216.34'])
  })

  it('turns DNS failures into SsrfError', async () => {
    const lookup = async () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    }
    await expect(resolveSafe('nx.test', 'http://nx.test/', lookup)).rejects.toThrow(SsrfError)
  })
})
