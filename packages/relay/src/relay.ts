// The relay: opens sealed tokens and streams playlists, segments, keys, init segments and subtitles from the
// upstream CDN, so the browser only ever sees /r/<token>.<ext>. No database: everything it needs is in the token.
import { createHash, timingSafeEqual } from 'node:crypto'
import { getConnInfo } from '@hono/node-server/conninfo'
import {
  clientIp,
  createFetcher,
  decodePlaylist,
  type Fetcher,
  type FetchResponse,
  openToken,
  type RelayToken,
  SsrfError,
  sealToken,
  type TokenKind,
  TooLargeError,
  trustList,
} from '@reconsumet/core'
import { type Context, Hono } from 'hono'
import type { RelayConfig } from './config.ts'
import { rewritePlaylist } from './hls.ts'
import { createLimits } from './limits.ts'

export interface RelayDeps {
  fetcher?: Fetcher
  /** Clock for token expiry, unix ms. */
  now?: () => number
  /** The socket's remote address (default: the Node server's). */
  remoteAddress?: (c: Context) => string
}

const EXT: Record<TokenKind, string> = { playlist: 'm3u8', segment: 'ts', key: 'key', init: 'mp4', subtitle: 'vtt' }
const SUBTITLE_TYPES: Record<string, string> = {
  vtt: 'text/vtt; charset=utf-8',
  ass: 'text/x-ssa; charset=utf-8',
  ssa: 'text/x-ssa; charset=utf-8',
  srt: 'application/x-subrip; charset=utf-8',
}
const FORWARDED = ['content-range', 'accept-ranges', 'last-modified', 'etag']
const PLAYLIST_MAX = 2 * 1024 * 1024
const KEY_MAX = 64 * 1024
const SUBTITLE_MAX = 8 * 1024 * 1024

const sha = (s: string) => createHash('sha256').update(s).digest()
const fail = (c: Context, status: 403 | 404 | 410 | 416 | 429 | 500 | 502, code: string, message: string) =>
  c.json({ error: { code, message } }, status)

export function createRelay(config: RelayConfig, deps: RelayDeps = {}) {
  const fetcher = deps.fetcher ?? createFetcher({ hostConcurrency: 64, maxConcurrency: 256, retry: { attempts: 1 } })
  const now = deps.now ?? Date.now
  const remote = deps.remoteAddress ?? ((c: Context) => getConnInfo(c).remote.address ?? '')
  const trusted = trustList(config.trustedProxies)
  const limits = createLimits(config)
  const requests = new Map<string, number>()
  const upstreamErrors = new Map<string, number>()
  // hosts come from upstream playlists: cap the label set so /metrics can't grow without bound
  const bump = (m: Map<string, number>, k: string) => {
    const key = m.has(k) || m.size < 200 ? k : 'other'
    m.set(key, (m.get(key) ?? 0) + 1)
  }

  const maxBytes = (k: TokenKind) =>
    k === 'key' ? KEY_MAX : k === 'subtitle' ? SUBTITLE_MAX : k === 'playlist' ? PLAYLIST_MAX : config.maxSegmentBytes

  const upstream = (t: RelayToken, headers: Record<string, string> = {}, method = 'GET') =>
    fetcher.request(t.u, {
      method,
      untrusted: true,
      headers: { ...t.h, ...headers },
      timeout: { totalMs: 120_000 },
      maxBytes: maxBytes(t.k),
    })

  /** An upstream failure as a response. Messages stay generic: errors carry the upstream URL. */
  const upstreamFail = (c: Context, t: RelayToken, e: unknown) => {
    bump(upstreamErrors, new URL(t.u).hostname)
    if (e instanceof SsrfError) return fail(c, 403, 'blocked_target', 'upstream address not allowed')
    if (e instanceof TooLargeError) return fail(c, 502, 'too_large', 'upstream response too large')
    return fail(c, 502, 'upstream', `upstream failed (${(e as Error)?.name ?? 'error'})`)
  }
  const badStatus = async (c: Context, t: RelayToken, res: FetchResponse) => {
    await res.body.cancel()
    bump(upstreamErrors, new URL(t.u).hostname)
    const status = res.status === 404 || res.status === 416 ? res.status : 502
    return fail(c, status, 'upstream', `upstream HTTP ${res.status}`)
  }

  async function playlist(c: Context, t: RelayToken): Promise<Response> {
    let text: string
    let base: string
    try {
      const res = await upstream(t)
      if (res.status !== 200) return badStatus(c, t, res)
      text = await res.body.text()
      base = res.url
    } catch (e) {
      return upstreamFail(c, t, e)
    }
    if (t.x) text = decodePlaylist(text, t.x)
    if (!text.trimStart().startsWith('#EXTM3U')) return fail(c, 502, 'bad_playlist', 'upstream sent no playlist')
    const mint = (u: string, k: TokenKind) => {
      const child: RelayToken = { u, k, e: now() + config.childTtlMs, h: t.h, s: t.s, ip: t.ip }
      if (k === 'playlist') child.x = t.x
      return `${sealToken(child, config.secrets[0]!)}.${EXT[k]}`
    }
    let out: string
    try {
      out = rewritePlaylist(text, base, mint, config.maxPlaylistLines)
    } catch {
      return fail(c, 502, 'bad_playlist', 'upstream playlist could not be rewritten')
    }
    limits.count(Buffer.byteLength(out))
    return new Response(out, {
      headers: {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  async function media(c: Context, t: RelayToken, ext: string, ip: string): Promise<Response> {
    const release = limits.open(ip)
    if (!release) return fail(c, 429, 'too_many_streams', 'too many streams from this address')
    const range = c.req.header('range')
    const head = c.req.method === 'HEAD'
    let res: FetchResponse
    try {
      res = await upstream(t, range ? { range } : {}, head ? 'HEAD' : 'GET')
    } catch (e) {
      release()
      return upstreamFail(c, t, e)
    }
    if (res.status !== 200 && res.status !== 206) {
      release()
      return badStatus(c, t, res)
    }
    const type = res.headers.get('content-type') ?? ''
    const headers = new Headers({
      'content-type':
        t.k === 'subtitle'
          ? (SUBTITLE_TYPES[ext] ?? SUBTITLE_TYPES.vtt!)
          : t.k === 'key'
            ? 'application/octet-stream'
            : /^(video\/|audio\/|application\/octet-stream|text\/vtt)/i.test(type) // vtt: HLS subtitle segments
              ? type
              : 'video/mp2t', // CDNs disguise segments as image/png, text/html…
      'x-content-type-options': 'nosniff',
    })
    for (const name of FORWARDED) {
      const v = res.headers.get(name)
      if (v) headers.set(name, v)
    }
    const length = res.headers.get('content-length')
    if (length && !res.headers.has('content-encoding')) headers.set('content-length', length) // decoded size differs
    if (head) {
      release()
      await res.body.cancel()
      return new Response(null, { status: res.status, headers })
    }
    return new Response(limits.pipe(ip, res.body.stream(), release), { status: res.status, headers })
  }

  const app = new Hono()
  app.onError((_e, c) => fail(c, 500, 'internal', 'internal error'))

  app.use('/r/*', async (c, next) => {
    const origin = c.req.header('origin')
    if (origin === undefined) return next() // native players send none
    if (!config.allowedOrigins.includes(origin)) return fail(c, 403, 'origin_not_allowed', 'origin not allowed')
    const cors = { 'access-control-allow-origin': origin, vary: 'origin' }
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204, {
        ...cors,
        'access-control-allow-methods': 'GET, HEAD',
        'access-control-allow-headers': 'range',
        'access-control-max-age': '600',
      })
    }
    await next()
    for (const [k, v] of Object.entries(cors)) c.res.headers.set(k, v)
    c.res.headers.set('access-control-expose-headers', 'content-length, content-range, accept-ranges')
  })

  app.get('/r/:file', async (c) => {
    const [sealed = '', ext = ''] = c.req.param('file').split('.')
    const t = openToken(sealed, config.secrets)
    let res: Response
    if (!t) res = fail(c, 403, 'bad_token', 'invalid token')
    else if (t.e < now()) res = fail(c, 410, 'expired', 'token expired')
    else {
      const ip = clientIp(remote(c), c.req.header('x-forwarded-for'), trusted)
      if (t.ip && t.ip !== ip) res = fail(c, 403, 'viewer_mismatch', 'token belongs to another viewer')
      else res = t.k === 'playlist' ? await playlist(c, t) : await media(c, t, ext.toLowerCase(), ip)
    }
    bump(requests, `${t?.k ?? 'none'}|${res.status}`)
    return res
  })

  app.get('/health', (c) => c.json({ ok: true }))

  app.get('/metrics', (c) => {
    if (!config.metricsToken) return c.notFound()
    // hashing first makes the compare constant-time even when the lengths differ
    if (!timingSafeEqual(sha(c.req.header('authorization') ?? ''), sha(`Bearer ${config.metricsToken}`))) {
      return c.json({ error: { code: 'unauthorized', message: 'bad metrics token' } }, 401)
    }
    const { bytesOut, activeStreams, throttledMs } = limits.stats
    const lines = [
      '# TYPE relay_bytes_out_total counter',
      `relay_bytes_out_total ${bytesOut}`,
      '# TYPE relay_active_streams gauge',
      `relay_active_streams ${activeStreams}`,
      '# TYPE relay_requests_total counter',
      ...[...requests].map(([k, n]) => {
        const [kind, status] = k.split('|')
        return `relay_requests_total{kind="${kind}",status="${status}"} ${n}`
      }),
      '# TYPE relay_upstream_errors_total counter',
      ...[...upstreamErrors].map(([host, n]) => `relay_upstream_errors_total{host="${host}"} ${n}`),
      '# TYPE relay_throttled_seconds_total counter',
      `relay_throttled_seconds_total ${throttledMs / 1000}`,
    ]
    return c.text(`${lines.join('\n')}\n`, 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
  })

  return { app, close: () => fetcher.close() }
}
