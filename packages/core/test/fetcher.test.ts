import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { allowForTests } from '../src/fetch/ssrf.ts'
import {
  BlockedError,
  createFetcher,
  type FetchEvent,
  type Fetcher,
  FetchTimeoutError,
  SolverNotImplementedError,
  SsrfError,
  TooLargeError,
  TooManyRedirectsError,
} from '../src/index.ts'
import { sleep, startServer } from './server.ts'

let srv: Awaited<ReturnType<typeof startServer>>
const open: Fetcher[] = []
const make = (...args: Parameters<typeof createFetcher>) => {
  const f = createFetcher(...args)
  open.push(f)
  return f
}
// *.test names resolve to the local server (or to whatever a test says), so the SSRF path runs for real
const lookupMap =
  (map: Record<string, string> = {}) =>
  async (host: string) => [
    { address: map[host] ?? '127.0.0.1', family: (map[host] ?? '127.0.0.1').includes(':') ? 6 : 4 },
  ]

beforeAll(async () => {
  srv = await startServer()
})
afterAll(() => srv.close())
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()))
  allowForTests.clear()
})

describe('basics', () => {
  it('returns status, headers, url, tier, timing and a body', async () => {
    srv.route('/hello', (_q, s) => s.writeHead(200, { 'content-type': 'application/json' }).end('{"hi":1}'))
    const events: FetchEvent[] = []
    const f = make({ onEvent: (e) => events.push(e) })
    const r = await f.request(srv.url('/hello'))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/json')
    expect(r.tier).toBe('plain')
    expect(r.profile).toBeNull()
    expect(r.timing.attempts).toBe(1)
    expect(await r.body.json()).toEqual({ hi: 1 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      host: '127.0.0.1',
      tier: 'plain',
      status: 200,
      class: 'ok',
      bytes: 8,
      retries: 0,
    })
  })

  it('the solver tier is a clear stub', async () => {
    await expect(make().request(srv.url('/hello'), { tier: 'solver' })).rejects.toThrow(SolverNotImplementedError)
  })

  it('host rules: suffix match, longest wins, default headers', async () => {
    srv.route('/hdr', (q, s) => s.end(JSON.stringify({ ref: q.headers.referer, x: q.headers['x-a'] })))
    const f = make({
      lookup: lookupMap(),
      rules: [
        { match: 'test', headers: { referer: 'https://generic/', 'x-a': 'test' } },
        { match: 'site.test', headers: { referer: 'https://site/' } },
      ],
    })
    expect(await (await f.request(srv.url('/hdr', 'cdn.site.test'))).body.json()).toEqual({ ref: 'https://site/' })
    expect(await (await f.request(srv.url('/hdr', 'other.test'))).body.json()).toEqual({
      ref: 'https://generic/',
      x: 'test',
    })
    // per-call headers beat rules
    const r = await f.request(srv.url('/hdr', 'cdn.site.test'), { headers: { Referer: 'https://call/' } })
    expect(await r.body.json()).toEqual({ ref: 'https://call/' })
  })
})

describe('retries', () => {
  it('retries 5xx with backoff, then succeeds', async () => {
    let n = 0
    srv.route('/flaky', (_q, s) => (++n < 3 ? s.writeHead(503).end('busy') : s.end('ok')))
    const events: FetchEvent[] = []
    const f = make({ retry: { baseMs: 10 }, onEvent: (e) => events.push(e) })
    const r = await f.request(srv.url('/flaky'))
    expect(await r.body.text()).toBe('ok')
    expect(r.timing.attempts).toBe(3)
    expect(events.map((e) => e.retries)).toEqual([2]) // one event per request, not per attempt
  })

  it('honours Retry-After on 429', async () => {
    let n = 0
    srv.route('/429', (_q, s) => (++n === 1 ? s.writeHead(429, { 'retry-after': '1' }).end() : s.end('ok')))
    const t0 = Date.now()
    const r = await make({ retry: { baseMs: 1 } }).request(srv.url('/429'))
    expect(await r.body.text()).toBe('ok')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950)
  })

  it('gives up when Retry-After is longer than maxMs, as rate-limited', async () => {
    srv.route('/429long', (_q, s) => s.writeHead(429, { 'retry-after': '3600' }).end())
    const err = await make({ retry: { maxMs: 1000 } })
      .request(srv.url('/429long'))
      .catch((e) => e)
    expect(err).toBeInstanceOf(BlockedError)
    expect(err.class).toBe('rate-limited')
    expect(srv.hits('/429long')).toBe(1)
  })

  it('retries network errors', async () => {
    let n = 0
    srv.route('/reset', (q, s) => (++n === 1 ? q.socket.destroy() : s.end('ok')))
    const r = await make({ retry: { baseMs: 10 } }).request(srv.url('/reset'))
    expect(await r.body.text()).toBe('ok')
  })

  it('does not retry POST by default', async () => {
    srv.route('/post503', (_q, s) => s.writeHead(503).end())
    const r = await make({ retry: { baseMs: 1 } }).request(srv.url('/post503'), { method: 'POST', body: 'x' })
    expect(r.status).toBe(503)
    await r.body.cancel()
    expect(srv.hits('/post503')).toBe(1)
  })
})

describe('limits', () => {
  it('rate limit spaces request starts per host', async () => {
    const starts: number[] = []
    srv.route('/rl', (_q, s) => {
      starts.push(Date.now())
      s.end('ok')
    })
    const f = make({ rules: [{ match: '127.0.0.1', rateLimit: { requests: 1, perMs: 150 } }] })
    await Promise.all([1, 2, 3].map(async () => (await f.request(srv.url('/rl'))).body.text()))
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!)
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(130)
  })

  it('per-host concurrency holds until the body is consumed', async () => {
    let inFlight = 0
    let max = 0
    srv.route('/slow', (_q, s) => {
      max = Math.max(max, ++inFlight)
      setTimeout(() => {
        inFlight--
        s.end('ok')
      }, 50)
    })
    const f = make({ rules: [{ match: '127.0.0.1', concurrency: 1 }] })
    await Promise.all([1, 2, 3].map(async () => (await f.request(srv.url('/slow'))).body.text()))
    expect(max).toBe(1)
  })

  it('global cap across hosts', async () => {
    let inFlight = 0
    let max = 0
    srv.route('/g', (_q, s) => {
      max = Math.max(max, ++inFlight)
      setTimeout(() => {
        inFlight--
        s.end('ok')
      }, 50)
    })
    const f = make({ maxConcurrency: 2, lookup: lookupMap() })
    await Promise.all(['a', 'b', 'c', 'd'].map(async (h) => (await f.request(srv.url('/g', `${h}.test`))).body.text()))
    expect(max).toBe(2)
  })
})

describe('timeouts and size cap', () => {
  it('total timeout covers a slow response', async () => {
    srv.route('/hang', (_q, s) => setTimeout(() => s.end('late'), 2000))
    const err = await make({ retry: { attempts: 0 }, timeout: { totalMs: 200 } })
      .request(srv.url('/hang'))
      .catch((e) => e)
    expect(err).toBeInstanceOf(FetchTimeoutError)
    expect(err.phase).toBe('total')
  })

  it('total timeout also covers reading the body', async () => {
    srv.route('/drip', (_q, s) => {
      s.writeHead(200)
      s.write('a')
      setTimeout(() => s.end('b'), 2000)
    })
    const r = await make({ retry: { attempts: 0 }, timeout: { totalMs: 300 } }).request(srv.url('/drip'))
    await expect(r.body.text()).rejects.toBeInstanceOf(FetchTimeoutError)
  })

  it('connect timeout (blackholed TEST-NET address)', async () => {
    const err = await make({ retry: { attempts: 0 }, timeout: { connectMs: 300 } })
      .request('http://192.0.2.1/')
      .catch((e) => e)
    expect(err).toBeInstanceOf(FetchTimeoutError)
    expect(err.phase).toBe('connect')
  })

  it('refuses a too-large Content-Length without reading', async () => {
    srv.route('/big', (_q, s) => s.writeHead(200, { 'content-length': '5000' }).end('x'.repeat(5000)))
    await expect(make({ maxBytes: 1000 }).request(srv.url('/big'))).rejects.toBeInstanceOf(TooLargeError)
  })

  it('enforces the cap while streaming (no Content-Length)', async () => {
    srv.route('/chunked', (_q, s) => {
      s.writeHead(200)
      for (let i = 0; i < 10; i++) s.write('x'.repeat(500))
      s.end()
    })
    const r = await make().request(srv.url('/chunked'), { maxBytes: 1200 })
    await expect(r.body.text()).rejects.toBeInstanceOf(TooLargeError)
  })
})

describe('redirects', () => {
  it('follows redirects and reports the final URL', async () => {
    srv.route('/r1', (_q, s) => s.writeHead(302, { location: '/r2' }).end())
    srv.route('/r2', (_q, s) => s.writeHead(301, { location: srv.url('/r3') }).end())
    srv.route('/r3', (_q, s) => s.end('done'))
    const r = await make().request(srv.url('/r1'))
    expect(r.url).toBe(srv.url('/r3'))
    expect(await r.body.text()).toBe('done')
  })

  it('stops after maxRedirects', async () => {
    srv.route('/loop', (_q, s) => s.writeHead(302, { location: '/loop' }).end())
    await expect(make({ maxRedirects: 3 }).request(srv.url('/loop'))).rejects.toBeInstanceOf(TooManyRedirectsError)
    expect(srv.hits('/loop')).toBe(4)
  })

  it('303 turns POST into GET', async () => {
    srv.route('/form', (_q, s) => s.writeHead(303, { location: '/method' }).end())
    srv.route('/method', (q, s) => s.end(q.method))
    const r = await make().request(srv.url('/form'), { method: 'POST', body: 'a=1' })
    expect(await r.body.text()).toBe('GET')
  })

  it('drops Authorization and Cookie headers on a cross-origin redirect', async () => {
    srv.route('/to-other', (_q, s) => s.writeHead(302, { location: srv.url('/echo-auth', 'other.test') }).end())
    srv.route('/echo-auth', (q, s) =>
      s.end(JSON.stringify({ a: q.headers.authorization ?? null, c: q.headers.cookie ?? null })),
    )
    const f = make({ lookup: lookupMap() })
    const r = await f.request(srv.url('/to-other', 'first.test'), {
      headers: { authorization: 'Bearer x', cookie: 'a=b' },
    })
    expect(await r.body.json()).toEqual({ a: null, c: null })
  })
})

describe('SSRF guard (untrusted: true)', () => {
  it('allows a public-looking host and pins the vetted address', async () => {
    allowForTests.add('127.0.0.1') // stand-in for a public address
    srv.route('/pub', (_q, s) => s.end('public'))
    const f = make({ lookup: lookupMap({ 'cdn.test': '127.0.0.1' }) })
    const r = await f.request(srv.url('/pub', 'cdn.test'), { untrusted: true })
    expect(await r.body.text()).toBe('public')
  })

  it('refuses private literals and private DNS answers', async () => {
    const f = make({ lookup: lookupMap({ 'evil.test': '10.0.0.5' }) })
    await expect(f.request('http://127.0.0.2/', { untrusted: true })).rejects.toBeInstanceOf(SsrfError)
    await expect(f.request('http://100.100.1.2/', { untrusted: true })).rejects.toBeInstanceOf(SsrfError)
    await expect(f.request(srv.url('/pub', 'evil.test'), { untrusted: true })).rejects.toBeInstanceOf(SsrfError)
    await expect(f.request('file:///etc/passwd', { untrusted: true })).rejects.toBeInstanceOf(SsrfError)
  })

  it('re-checks every redirect hop', async () => {
    allowForTests.add('127.0.0.1')
    srv.route('/to-metadata', (_q, s) =>
      s.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end(),
    )
    srv.route('/to-private-name', (_q, s) => s.writeHead(302, { location: srv.url('/pub', 'internal.test') }).end())
    const f = make({
      lookup: lookupMap({ 'cdn.test': '127.0.0.1', 'internal.test': '192.168.1.10' }),
      retry: { attempts: 0 },
    })
    await expect(f.request(srv.url('/to-metadata', 'cdn.test'), { untrusted: true })).rejects.toBeInstanceOf(SsrfError)
    await expect(f.request(srv.url('/to-private-name', 'cdn.test'), { untrusted: true })).rejects.toBeInstanceOf(
      SsrfError,
    )
  })

  it('trusted calls are not checked (sources may use internal services)', async () => {
    srv.route('/internal', (_q, s) => s.end('internal'))
    expect(await (await make().request(srv.url('/internal'))).body.text()).toBe('internal')
  })
})

describe('blocks, classification, escalation', () => {
  const challenge = '<html><head><title>Just a moment...</title></head></html>'

  it('throws BlockedError with the class', async () => {
    srv.route('/cf', (_q, s) =>
      s.writeHead(403, { server: 'cloudflare', 'cf-ray': 'x', 'cf-mitigated': 'challenge' }).end(challenge),
    )
    const events: FetchEvent[] = []
    const err = await make({ onEvent: (e) => events.push(e) })
      .request(srv.url('/cf'))
      .catch((e) => e)
    expect(err).toBeInstanceOf(BlockedError)
    expect(err.class).toBe('cf-challenge')
    expect(events[0]).toMatchObject({ status: 403, class: 'cf-challenge' })
  })

  it('escalates plain -> impersonate on a fingerprint block and remembers the host', async () => {
    // a stand-in for a fingerprint-gated CDN: only a browser-looking client gets through
    srv.route('/gated', (q, s) =>
      /Chrome\//.test(q.headers['user-agent'] ?? '') ? s.end('real content') : s.writeHead(403).end('denied'),
    )
    const events: FetchEvent[] = []
    const f = make({ escalate: { ttlMs: 60_000 }, onEvent: (e) => events.push(e) })
    const r = await f.request(srv.url('/gated'))
    expect(r.tier).toBe('impersonate')
    expect(r.profile).toBe('chrome')
    expect(await r.body.text()).toBe('real content')
    expect(events.map((e) => [e.tier, e.class, e.escalated])).toEqual([
      ['plain', 'forbidden', false],
      ['impersonate', 'ok', true],
    ])
    // remembered: next request goes straight to impersonate
    const r2 = await f.request(srv.url('/gated'))
    expect(r2.tier).toBe('impersonate')
    await r2.body.text()
    expect(events).toHaveLength(3)
  })

  it('no escalation without config, or when a tier is forced', async () => {
    srv.route('/gated2', (_q, s) => s.writeHead(403).end('denied'))
    await expect(make().request(srv.url('/gated2'))).rejects.toMatchObject({ class: 'forbidden', tier: 'plain' })
    const f = make({ escalate: { ttlMs: 1000 } })
    await expect(f.request(srv.url('/gated2'), { tier: 'plain' })).rejects.toMatchObject({ tier: 'plain' })
  })
})

describe('streaming and cookies', () => {
  it('streams: the first chunk arrives before the response ends', async () => {
    srv.route('/stream', (_q, s) => {
      s.writeHead(200)
      s.write('first')
      setTimeout(() => s.end('second'), 400)
    })
    const r = await make().request(srv.url('/stream'))
    const reader = r.body.stream().getReader()
    const t0 = Date.now()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('first')
    expect(Date.now() - t0).toBeLessThan(300)
    let rest = ''
    for (let c = await reader.read(); !c.done; c = await reader.read()) rest += new TextDecoder().decode(c.value)
    expect(rest).toBe('second')
  })

  it('a body can only be read once', async () => {
    srv.route('/once', (_q, s) => s.end('x'))
    const r = await make().request(srv.url('/once'))
    await r.body.text()
    await expect(r.body.text()).rejects.toThrow(TypeError)
  })

  it('cookie jar is opt-in and per fetcher', async () => {
    srv.route('/set', (_q, s) => s.writeHead(200, { 'set-cookie': 'sid=abc; Path=/' }).end())
    srv.route('/cookie', (q, s) => s.end(q.headers.cookie ?? 'none'))
    const withJar = make({ cookies: true })
    await (await withJar.request(srv.url('/set'))).body.cancel()
    expect(await (await withJar.request(srv.url('/cookie'))).body.text()).toBe('sid=abc')
    const noJar = make()
    await (await noJar.request(srv.url('/set'))).body.cancel()
    expect(await (await noJar.request(srv.url('/cookie'))).body.text()).toBe('none')
  })

  it('events fire after the body is consumed, with byte counts', async () => {
    srv.route('/bytes', (_q, s) => s.end('x'.repeat(1234)))
    const events: FetchEvent[] = []
    const r = await make({ onEvent: (e) => events.push(e) }).request(srv.url('/bytes'))
    expect(events).toHaveLength(0)
    await r.body.bytes()
    await sleep(0)
    expect(events[0]?.bytes).toBe(1234)
  })
})
