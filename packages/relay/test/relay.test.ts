import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { createFetcher, type RelayToken, sealToken } from '@reconsumet/core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
// the SSRF guard blocks 127.0.0.1; this test hook lets the fake upstream through (same module instance as the
// @reconsumet/core the relay imports, which resolves to core's dist)
import { allowForTests } from '../../core/dist/fetch/ssrf.js'
import { sleep, startServer } from '../../core/test/server.ts'
import { loadConfig } from '../src/config.ts'
import { createRelay } from '../src/relay.ts'

const SECRET = 's'.repeat(32)
const OLD_SECRET = 'o'.repeat(32)
const SITE = 'https://site.example'
const RELAY = 'http://relay.example/r/'

let up: Awaited<ReturnType<typeof startServer>>
const cdn = (path: string) => up.url(path, 'cdn.test')

beforeAll(async () => {
  up = await startServer()
  allowForTests.add('127.0.0.1') // stands in for a public CDN address; 127.0.0.2 and 10.x stay blocked
})
afterAll(async () => {
  allowForTests.clear()
  await up.close()
})

const hosts: Record<string, string> = { 'cdn.test': '127.0.0.1', 'internal.test': '10.0.0.5' }
const fetcher = () =>
  createFetcher({
    hostConcurrency: 64,
    maxConcurrency: 256,
    retry: { attempts: 1, baseMs: 1 },
    lookup: async (host) => {
      const address = hosts[host]
      if (!address) throw new Error(`unknown host ${host}`)
      return [{ address, family: 4 }]
    },
  })

const relays: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(relays.splice(0).map((r) => r.close()))
})

function makeRelay(env: Record<string, string> = {}) {
  const config = loadConfig({
    RELAY_SECRET: SECRET,
    RELAY_SECRET_PREVIOUS: OLD_SECRET,
    RELAY_ALLOWED_ORIGINS: SITE,
    TRUSTED_PROXIES: '127.0.0.1',
    RELAY_METRICS_TOKEN: 'metrics-secret',
    RELAY_MAX_STREAMS_PER_IP: '2',
    RELAY_IP_MBPS: '10000',
    RELAY_GLOBAL_MBPS: '10000',
    RELAY_MAX_SEGMENT_MB: '1',
    ...env,
  })
  const relay = createRelay(config, { fetcher: fetcher(), remoteAddress: () => '127.0.0.1' })
  relays.push(relay)
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    relay.app.request(path, { method, headers })
  const metrics = async () => (await get('/metrics', { authorization: 'Bearer metrics-secret' })).text()
  return { relay, get, metrics }
}

const token = (t: Pick<RelayToken, 'u' | 'k'> & Partial<RelayToken>, secret = SECRET) =>
  sealToken({ e: Date.now() + 60_000, ...t }, secret)
const path = (t: Pick<RelayToken, 'u' | 'k'> & Partial<RelayToken>, ext = 'ts') => `/r/${token(t)}.${ext}`
/** A URI from a rewritten playlist, resolved the way the browser does against the playlist's own /r/ URL. */
const child = (uri: string) => new URL(uri, `${RELAY}parent.m3u8`).pathname
const uriLines = (text: string) => text.split('\n').filter((l) => l && !l.startsWith('#'))
const attr = (text: string, tag: string) => child(new RegExp(`${tag}:.*URI="([^"]+)"`).exec(text)![1]!)

const xor = (s: string, keyB64: string) => {
  const k = Buffer.from(keyB64, 'base64')
  const b = Buffer.from(s)
  for (let i = 0; i < b.length; i++) b[i] = b[i]! ^ k[i % k.length]!
  return b.toString('base64')
}

const SEGMENT = Buffer.alloc(300_000, 7)

describe('playlists', () => {
  it('master → child playlist → key, init and segment via the minted relative URLs', async () => {
    const referers: string[] = []
    up.route('/start.m3u8', (_q, s) => s.writeHead(302, { location: '/hls/master.m3u8' }).end())
    up.route('/hls/master.m3u8', (q, s) => {
      referers.push(q.headers.referer ?? '')
      s.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/720.m3u8\n')
    })
    up.route('/hls/v/720.m3u8', (_q, s) =>
      s.end(
        [
          '#EXTM3U',
          '#EXT-X-KEY:METHOD=AES-128,URI="/keys/k.bin"',
          '#EXT-X-MAP:URI="init.mp4"',
          '#EXTINF:4,',
          `//cdn.test:${up.port}/seg/0.ts`,
          '',
        ].join('\n'),
      ),
    )
    up.route('/keys/k.bin', (_q, s) => s.end('0123456789abcdef'))
    up.route('/hls/v/init.mp4', (_q, s) => s.writeHead(200, { 'content-type': 'video/mp4' }).end('init'))
    up.route('/seg/0.ts', (q, s) => {
      referers.push(q.headers.referer ?? '')
      s.writeHead(200, {
        'content-type': 'image/png',
        'content-length': SEGMENT.length,
        'set-cookie': 'a=b',
        server: 'cdn',
      }).end(SEGMENT)
    })

    const { get } = makeRelay()
    const h = { referer: 'https://embed.example/' }
    const master = await get(path({ u: cdn('/start.m3u8'), k: 'playlist', h }, 'm3u8'))
    expect(master.status).toBe(200)
    expect(master.headers.get('content-type')).toBe('application/vnd.apple.mpegurl')
    expect(master.headers.get('cache-control')).toBe('no-store')
    const masterText = await master.text()
    expect(masterText).not.toMatch(/cdn\.test|127\.0\.0\.1/)

    const [variant] = uriLines(masterText)
    expect(variant).toMatch(/^[\w-]+\.m3u8$/) // relative: works under any relay hostname
    const media = await get(child(variant!))
    expect(media.status).toBe(200)
    const mediaText = await media.text()
    expect(mediaText).not.toMatch(/cdn\.test|127\.0\.0\.1/)

    const key = await get(attr(mediaText, '#EXT-X-KEY'))
    expect(key.headers.get('content-type')).toBe('application/octet-stream')
    expect(await key.text()).toBe('0123456789abcdef')
    const init = await get(attr(mediaText, '#EXT-X-MAP'))
    expect(init.headers.get('content-type')).toBe('video/mp4')
    expect(await init.text()).toBe('init')

    const seg = await get(child(uriLines(mediaText)[0]!))
    expect(seg.status).toBe(200)
    expect(seg.headers.get('content-type')).toBe('video/mp2t') // image/png disguise replaced
    expect(seg.headers.get('content-length')).toBe(String(SEGMENT.length))
    expect(seg.headers.get('x-content-type-options')).toBe('nosniff')
    expect(seg.headers.get('set-cookie')).toBeNull()
    expect(seg.headers.get('server')).toBeNull()
    expect(Buffer.from(await seg.arrayBuffer()).equals(SEGMENT)).toBe(true)
    expect(referers).toEqual(['https://embed.example/', 'https://embed.example/']) // token headers inherited
  })

  it('decodes XOR playlists, and child playlists inherit the key', async () => {
    const x = Buffer.from('secret-key').toString('base64')
    up.route('/x/master.m3u8', (_q, s) => s.end(xor('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\n', x)))
    up.route('/x/child.m3u8', (_q, s) => s.end(xor('#EXTM3U\n#EXTINF:4,\nseg.ts\n', x)))
    up.route('/x/seg.ts', (_q, s) => s.end('plain segment'))
    const { get } = makeRelay()
    const master = await (await get(path({ u: cdn('/x/master.m3u8'), k: 'playlist', x }, 'm3u8'))).text()
    const media = await get(child(uriLines(master)[0]!))
    expect(media.status).toBe(200)
    const seg = await get(child(uriLines(await media.text())[0]!))
    expect(await seg.text()).toBe('plain segment')
  })

  it('refuses a body that is not a playlist, and mirrors upstream 404', async () => {
    up.route('/html.m3u8', (_q, s) => s.end('<html>nope</html>'))
    const { get } = makeRelay()
    const bad = await get(path({ u: cdn('/html.m3u8'), k: 'playlist' }, 'm3u8'))
    expect(bad.status).toBe(502)
    expect(await bad.json()).toEqual({ error: { code: 'bad_playlist', message: 'upstream sent no playlist' } })
    const missing = await get(path({ u: cdn('/missing.m3u8'), k: 'playlist' }, 'm3u8'))
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('upstream')
  })
})

describe('media', () => {
  it('forwards Range and returns 206 with content-range', async () => {
    let gotRange = ''
    up.route('/range.ts', (q, s) => {
      gotRange = q.headers.range ?? ''
      const [a, b] = gotRange.replace('bytes=', '').split('-').map(Number)
      s.writeHead(206, {
        'content-range': `bytes ${a}-${b}/${SEGMENT.length}`,
        'accept-ranges': 'bytes',
        'content-type': 'video/mp2t',
      }).end(SEGMENT.subarray(a, b! + 1))
    })
    const { get } = makeRelay()
    const res = await get(path({ u: cdn('/range.ts'), k: 'segment' }), { range: 'bytes=100-199' })
    expect(gotRange).toBe('bytes=100-199')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 100-199/${SEGMENT.length}`)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect((await res.arrayBuffer()).byteLength).toBe(100)
  })

  it('serves subtitles with the content type of their extension, and HEAD without a body', async () => {
    up.route('/sub', (_q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end('[Script Info]'))
    const { get, metrics } = makeRelay()
    const t = { u: cdn('/sub'), k: 'subtitle' as const }
    for (const [ext, type] of [
      ['ass', 'text/x-ssa; charset=utf-8'],
      ['srt', 'application/x-subrip; charset=utf-8'],
    ]) {
      const res = await get(path(t, ext))
      expect(res.headers.get('content-type')).toBe(type)
      expect(await res.text()).toBe('[Script Info]')
    }
    const head = await get(path(t, 'vtt'), {}, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('text/vtt; charset=utf-8')
    expect(await head.text()).toBe('')
    expect(await metrics()).toMatch(/relay_active_streams 0/)
  })

  it('502s a segment over the size cap', async () => {
    up.route('/big.ts', (_q, s) => s.end(Buffer.alloc(1024 * 1024 + 1)))
    const { get } = makeRelay()
    const res = await get(path({ u: cdn('/big.ts'), k: 'segment' }))
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('too_large')
  })

  it('blocks private targets, also behind an upstream redirect (SSRF)', async () => {
    up.route('/to-loopback', (_q, s) => s.writeHead(302, { location: `http://127.0.0.2:${up.port}/x` }).end())
    up.route('/to-internal', (_q, s) => s.writeHead(302, { location: `http://internal.test:${up.port}/x` }).end())
    up.route('/x', (_q, s) => s.end('secret'))
    const { get } = makeRelay()
    for (const u of [cdn('/to-loopback'), cdn('/to-internal'), 'http://169.254.169.254/latest/meta-data/']) {
      const res = await get(path({ u, k: 'segment' }))
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('blocked_target')
    }
    expect(up.hits('/x')).toBe(0)
  })
})

describe('tokens', () => {
  it('rejects expired, tampered and foreign tokens; accepts the previous secret', async () => {
    up.route('/ok.ts', (_q, s) => s.end('ok'))
    const { get } = makeRelay()
    const u = cdn('/ok.ts')
    const expired = await get(`/r/${sealToken({ u, k: 'segment', e: Date.now() - 1 }, SECRET)}.ts`)
    expect(expired.status).toBe(410)
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe('expired')

    const good = token({ u, k: 'segment' })
    const tampered = good.slice(0, 20) + (good[20] === 'A' ? 'B' : 'A') + good.slice(21)
    expect((await get(`/r/${tampered}.ts`)).status).toBe(403)
    expect((await get(`/r/${token({ u, k: 'segment' }, 'f'.repeat(32))}.ts`)).status).toBe(403)
    expect((await get('/r/garbage.ts')).status).toBe(403)

    const rotated = await get(`/r/${token({ u, k: 'segment' }, OLD_SECRET)}.ts`)
    expect(rotated.status).toBe(200)
    expect(await rotated.text()).toBe('ok')
  })

  it('enforces the viewer binding, and child tokens inherit it', async () => {
    up.route('/bound.m3u8', (_q, s) => s.end('#EXTM3U\n#EXTINF:4,\nok.ts\n'))
    up.route('/ok.ts', (_q, s) => s.end('ok'))
    const { get } = makeRelay()
    const p = path({ u: cdn('/bound.m3u8'), k: 'playlist', ip: '203.0.113.7' }, 'm3u8')
    const viewer = { 'x-forwarded-for': '203.0.113.7' } // the socket peer 127.0.0.1 is a trusted proxy
    const other = { 'x-forwarded-for': '198.51.100.1' }
    expect((await get(p, other)).status).toBe(403)
    const res = await get(p, viewer)
    expect(res.status).toBe(200)
    const seg = child(uriLines(await res.text())[0]!)
    expect((await get(seg, viewer)).status).toBe(200)
    const denied = await get(seg, other)
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('viewer_mismatch')
  })
})

describe('CORS', () => {
  it('allows listed origins, refuses others, answers preflights, and leaves native players alone', async () => {
    up.route('/ok.ts', (_q, s) => s.end('ok'))
    const { get } = makeRelay()
    const p = path({ u: cdn('/ok.ts'), k: 'segment' })

    const allowed = await get(p, { origin: SITE })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(SITE)
    expect(allowed.headers.get('vary')).toBe('origin')
    expect(allowed.headers.get('access-control-expose-headers')).toBe('content-length, content-range, accept-ranges')
    await allowed.text()

    const denied = await get(p, { origin: 'https://evil.example' })
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('origin_not_allowed')

    const pre = await get(p, { origin: SITE, 'access-control-request-headers': 'range' }, 'OPTIONS')
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe(SITE)
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, HEAD')
    expect(pre.headers.get('access-control-allow-headers')).toBe('range')
    expect(pre.headers.get('access-control-max-age')).toBe('600')

    const native = await get(p)
    expect(native.status).toBe(200)
    expect(native.headers.get('access-control-allow-origin')).toBeNull()
    await native.text()
  })
})

describe('limits', () => {
  // writes one chunk, then holds the response open until the test ends
  const hold = () =>
    up.route('/hold.ts', (_q, s) => {
      s.writeHead(200, { 'content-type': 'video/mp2t' })
      s.write(Buffer.alloc(1000))
    })

  it('caps streams per IP and frees the slot when the client cancels', async () => {
    hold()
    const { get, metrics } = makeRelay()
    const p = path({ u: cdn('/hold.ts'), k: 'segment' })
    const a = await get(p)
    const b = await get(p)
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const third = await get(p)
    expect(third.status).toBe(429)
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe('too_many_streams')
    const other = await get(p, { 'x-forwarded-for': '198.51.100.9' })
    expect(other.status).toBe(200) // other viewers unaffected
    expect(await metrics()).toMatch(/relay_active_streams 3/)

    await a.body!.cancel()
    expect(await metrics()).toMatch(/relay_active_streams 2/)
    const d = await get(p)
    expect(d.status).toBe(200)
    await Promise.all([b, other, d].map((r) => r.body!.cancel())) // held upstream bodies would block close()
    expect(await metrics()).toMatch(/relay_active_streams 0/)
  })

  it('frees the slot when the HTTP client disconnects mid-stream (real server)', async () => {
    hold()
    const config = loadConfig({ RELAY_SECRET: SECRET, RELAY_METRICS_TOKEN: 'm'.repeat(8) })
    const relay = createRelay(config, { fetcher: fetcher() })
    relays.push(relay)
    const server = serve({ fetch: relay.app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const active = async () =>
      (await (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer mmmmmmmm' } })).text()).match(
        /relay_active_streams (\d+)/,
      )![1]
    try {
      const ac = new AbortController()
      const res = await fetch(`${base}${path({ u: cdn('/hold.ts'), k: 'segment' })}`, { signal: ac.signal })
      const reader = res.body!.getReader()
      expect((await reader.read()).value?.byteLength).toBeGreaterThan(0)
      expect(await active()).toBe('1')
      ac.abort()
      for (let i = 0; i < 50 && (await active()) !== '0'; i++) await sleep(20)
      expect(await active()).toBe('0')
    } finally {
      ;(server as Server).closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  })

  it('throttles: 1 MB at 4 Mbit/s per IP takes about 1 s after the 1 s burst', async () => {
    const body = Buffer.alloc(1_000_000, 1)
    up.route('/mb.ts', (_q, s) => s.end(body))
    const { get, metrics } = makeRelay({ RELAY_IP_MBPS: '4', RELAY_MAX_SEGMENT_MB: '2' })
    const t0 = performance.now()
    const res = await get(path({ u: cdn('/mb.ts'), k: 'segment' }))
    expect((await res.arrayBuffer()).byteLength).toBe(body.length)
    const ms = performance.now() - t0
    expect(ms).toBeGreaterThan(800)
    expect(ms).toBeLessThan(2500)
    const m = await metrics()
    expect(Number(/relay_throttled_seconds_total ([\d.]+)/.exec(m)![1])).toBeGreaterThan(0.5)
    expect(Number(/relay_bytes_out_total (\d+)/.exec(m)![1])).toBe(body.length)
  })
})

describe('health and metrics', () => {
  it('serves /health and guards /metrics', async () => {
    up.route('/m.ts', (_q, s) => s.end('ok'))
    const { get, metrics } = makeRelay()
    expect(await (await get('/health')).json()).toEqual({ ok: true })
    expect((await get('/metrics')).status).toBe(401)
    expect((await get('/metrics', { authorization: 'Bearer wrong' })).status).toBe(401)
    await (await get(path({ u: cdn('/m.ts'), k: 'segment' }))).text()
    await get(path({ u: cdn('/nope.ts'), k: 'segment' }))
    await get('/r/garbage.ts')
    const m = await metrics()
    expect(m).toContain('relay_requests_total{kind="segment",status="200"} 1')
    expect(m).toContain('relay_requests_total{kind="segment",status="404"} 1')
    expect(m).toContain('relay_requests_total{kind="none",status="403"} 1')
    expect(m).toContain('relay_upstream_errors_total{host="cdn.test"} 1')
    expect(m).toContain('relay_bytes_out_total 2')
    expect(m).toContain('# TYPE relay_active_streams gauge')

    const bare = createRelay(loadConfig({ RELAY_SECRET: SECRET }), { fetcher: fetcher() })
    relays.push(bare)
    expect((await bare.app.request('/metrics', { headers: { authorization: 'Bearer ' } })).status).toBe(404)
  })
})
