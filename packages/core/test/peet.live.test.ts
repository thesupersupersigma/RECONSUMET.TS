// Live: hits tls.peet.ws once per tier. Run with `pnpm test:live` (excluded from `pnpm test`).
import { afterAll, describe, expect, it } from 'vitest'
import { createFetcher, SolverNotImplementedError } from '../src/index.ts'

const PEET = 'https://tls.peet.ws/api/all'
const f = createFetcher({ retry: { attempts: 0 } })
afterAll(() => f.close())

interface Peet {
  http_version: string
  user_agent: string
  tls: { ja4: string }
  http2?: { akamai_fingerprint: string }
}

describe('tls.peet.ws through each tier', () => {
  it('plain: no browser fingerprint', async () => {
    const r = await f.request(PEET, { tier: 'plain' })
    const j = await r.body.json<Peet>()
    console.log('plain', j.http_version, j.tls.ja4)
    expect(j.tls.ja4).not.toMatch(/^t13d1516h2_8daaf6152771_/)
  })

  it('impersonate: real Chrome JA4 and HTTP/2 fingerprint', async () => {
    const r = await f.request(PEET, { tier: 'impersonate', profile: 'chrome' })
    const j = await r.body.json<Peet>()
    console.log('impersonate', j.http_version, j.tls.ja4, j.http2?.akamai_fingerprint)
    expect(j.http_version).toBe('h2')
    expect(j.tls.ja4).toMatch(/^t13d1516h2_8daaf6152771_/)
    expect(j.http2?.akamai_fingerprint).toBe('1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p')
    expect(j.user_agent).toMatch(/Chrome\//)
  })

  it('solver: not implemented yet', async () => {
    await expect(f.request(PEET, { tier: 'solver' })).rejects.toBeInstanceOf(SolverNotImplementedError)
  })
})
