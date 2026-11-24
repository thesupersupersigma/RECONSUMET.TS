import { describe, expect, it } from 'vitest'
import { classify } from '../src/fetch/classify.ts'

const h = (o: Record<string, string> = {}) => new Headers(o)
const cf = { server: 'cloudflare', 'cf-ray': '8f00000000000000-AMS' }

describe('classify', () => {
  it('ok for normal responses, including non-block errors', () => {
    expect(classify({ status: 200, headers: h() })).toBe('ok')
    expect(classify({ status: 404, headers: h(cf) })).toBe('ok')
    expect(classify({ status: 500, headers: h() })).toBe('ok')
  })

  it('Cloudflare challenge by header or by page', () => {
    expect(classify({ status: 403, headers: h({ ...cf, 'cf-mitigated': 'challenge' }) })).toBe('cf-challenge')
    const page =
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>'
    expect(classify({ status: 403, headers: h(cf), body: page })).toBe('cf-challenge')
    expect(classify({ status: 503, headers: h(cf), body: 'window._cf_chl_opt={cvId:"3"}' })).toBe('cf-challenge')
  })

  it('Cloudflare firewall blocks (1020, 1010, Attention Required)', () => {
    expect(classify({ status: 403, headers: h(cf), body: 'error code: 1020' })).toBe('cf-block')
    expect(classify({ status: 403, headers: h(cf), body: '<title>Attention Required! | Cloudflare</title>' })).toBe(
      'cf-block',
    )
    expect(classify({ status: 403, headers: h(cf), body: '<span class="cf-error-details">Error 1010</span>' })).toBe(
      'cf-block',
    )
  })

  it("an origin's own 403 behind Cloudflare is just forbidden", () => {
    expect(classify({ status: 403, headers: h(cf), body: '<h1>Forbidden</h1>' })).toBe('forbidden')
    expect(classify({ status: 401, headers: h() })).toBe('forbidden')
  })

  it('DDoS-Guard', () => {
    expect(classify({ status: 403, headers: h({ server: 'ddos-guard' }), body: '<title>DDoS-Guard</title>' })).toBe(
      'ddos-guard',
    )
    expect(
      classify({
        status: 200,
        headers: h({ server: 'ddos-guard' }),
        body: '<script src="https://check.ddos-guard.net/check.js">',
      }),
    ).toBe('ddos-guard')
    expect(classify({ status: 200, headers: h({ server: 'ddos-guard' }), body: '<html>real page</html>' })).toBe('ok')
  })

  it('rate limited: 429 and Cloudflare 1015', () => {
    expect(classify({ status: 429, headers: h() })).toBe('rate-limited')
    expect(classify({ status: 429, headers: h(cf), body: 'error code: 1015' })).toBe('rate-limited')
  })
})
