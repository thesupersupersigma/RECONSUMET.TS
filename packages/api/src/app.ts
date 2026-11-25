import { getConnInfo } from '@hono/node-server/conninfo'
import { swaggerUI } from '@hono/swagger-ui'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  type AniList,
  AniListCapError,
  type AniSkip,
  type Audio,
  clientIp,
  createMatcher,
  type RelayToken,
  type Source,
  type StreamResult,
  sealToken,
  streamingEpisodeExtras,
  trustList,
} from '@reconsumet/core'
import { type Db, latestHealth, PgCatalogStore, pgCache, pgMappingStore, verifyApiKey } from '@reconsumet/db'
import type { Context } from 'hono'
import type { ApiConfig } from './config.ts'
import {
  AnilistIdParam,
  AnimeSchema,
  AudioSchema,
  CatalogEntrySchema,
  EpisodesSchema,
  ErrorSchema,
  SkipSchema,
  SourceSchema,
  StatusSchema,
  StreamsSchema,
} from './schemas.ts'

export const VERSION = '0.6.0'

export class ApiError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 429 | 502 | 503
  readonly code: string
  constructor(status: ApiError['status'], code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface AppDeps {
  config: ApiConfig
  db: Db
  /** Sources in preference order. */
  sources: Map<string, Source>
  anilist: Pick<AniList, 'media' | 'usage'>
  /** null when ANISKIP_ENABLED=false. */
  aniskip: Pick<AniSkip, 'skipTimes'> | null
  /** The socket's address (default: from @hono/node-server); tests inject one. */
  remoteAddr?: (c: Context) => string
}

type Env = { Variables: { ip: string; key: { id: number; name: string; rateLimit: number | null } | null } }

const MIN = 60_000
const STREAM_CACHE_MS = 5 * MIN
const EPISODES_CACHE_MS = 30 * MIN

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})
const errors = {
  400: json(ErrorSchema, 'Invalid request'),
  401: json(ErrorSchema, 'Missing or invalid API key'),
  404: json(ErrorSchema, 'Not found'),
  429: json(ErrorSchema, 'Rate limited'),
  502: json(ErrorSchema, 'A source or AniList failed'),
  503: json(ErrorSchema, 'AniList budget used up and nothing cached (anilist_cap)'),
}
const SourceQuery = z.object({ source: z.string().optional().openapi({ example: 'reanime' }) })

/** Fixed one-minute windows in memory. shortcut: per process; move to Postgres/Redis if the API runs >1 instance. */
function windows() {
  const hits = new Map<string, { n: number; reset: number }>()
  let prune = 0
  return (key: string, limit: number, now = Date.now()) => {
    if (now > prune) {
      for (const [k, w] of hits) if (w.reset <= now) hits.delete(k)
      prune = now + MIN
    }
    let w = hits.get(key)
    if (!w || w.reset <= now) {
      w = { n: 0, reset: now + MIN }
      hits.set(key, w)
    }
    w.n++
    return { ok: w.n <= limit, remaining: Math.max(0, limit - w.n), reset: w.reset }
  }
}

export function createApp(deps: AppDeps) {
  const { config, db, sources, anilist, aniskip } = deps
  const catalog = new PgCatalogStore(db)
  const matcher = createMatcher({ media: anilist.media, catalog, store: pgMappingStore(db) })
  const streamCache = pgCache(db, 'streams')
  const trusted = trustList(config.trustedProxies)
  const hit = windows()
  const keyCache = new Map<string, { key: Env['Variables']['key']; until: number }>()
  const remoteAddr =
    deps.remoteAddr ??
    ((c: Context) => {
      try {
        return getConnInfo(c).remote.address ?? ''
      } catch {
        return ''
      }
    })

  /** AniList details; AniList failures that aren't the budget → 502 (stale answers are already handled inside). */
  const details = async (anilistId: number) => {
    const m = await anilist.media(anilistId).catch((e) => {
      if (e instanceof AniListCapError) throw e
      throw new ApiError(502, 'anilist', `AniList: ${(e as Error).message}`)
    })
    if (!m) throw new ApiError(404, 'not_found', `no anime ${anilistId} on AniList`)
    return m
  }

  const pickSources = (id: string | undefined): Source[] => {
    if (!id) return [...sources.values()]
    const s = sources.get(id)
    if (!s)
      throw new ApiError(400, 'unknown_source', `unknown source "${id}" (have: ${[...sources.keys()].join(', ')})`)
    return [s]
  }

  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const msg = result.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ')
        return c.json({ error: { code: 'invalid_request', message: msg } }, 400)
      }
    },
  })

  app.onError((e, c) => {
    if (e instanceof ApiError) return c.json({ error: { code: e.code, message: e.message } }, e.status)
    if (e instanceof AniListCapError) return c.json({ error: { code: 'anilist_cap', message: e.message } }, 503)
    console.error(e)
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500)
  })
  app.notFound((c) => c.json({ error: { code: 'not_found', message: `no route ${c.req.method} ${c.req.path}` } }, 404))

  // who is calling + rate limits, for every /v1 route
  app.use('/v1/*', async (c, next) => {
    const ip = clientIp(remoteAddr(c), c.req.header(config.clientIpHeader), trusted)
    c.set('ip', ip)
    const raw = c.req.header('x-api-key') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    let key: Env['Variables']['key'] = null
    if (raw) {
      const cached = keyCache.get(raw)
      if (cached && cached.until > Date.now()) key = cached.key
      else {
        key = await verifyApiKey(db, raw)
        keyCache.set(raw, { key, until: Date.now() + MIN })
      }
      if (!key) throw new ApiError(401, 'bad_key', 'invalid or revoked API key')
    }
    c.set('key', key)
    const w = key ? hit(`k:${key.id}`, key.rateLimit ?? config.keyPerMin) : hit(`ip:${ip}`, config.ipPerMin)
    c.header('ratelimit-remaining', String(w.remaining))
    c.header('ratelimit-reset', String(Math.ceil((w.reset - Date.now()) / 1000)))
    if (!w.ok) {
      c.header('retry-after', String(Math.ceil((w.reset - Date.now()) / 1000)))
      throw new ApiError(429, 'rate_limited', 'too many requests')
    }
    await next()
  })

  /** A relay URL for one upstream URL; the browser only ever sees these. */
  const relayUrl = (t: Omit<RelayToken, 'e'>, ext: string, expires: number) =>
    `${config.relayPublicUrl}/r/${sealToken({ ...t, e: expires }, config.relaySecret)}.${ext}`

  const routes = app
    .openapi(
      createRoute({
        method: 'get',
        path: '/v1/health',
        tags: ['meta'],
        responses: { 200: json(z.object({ ok: z.boolean(), version: z.string() }), 'API is up') },
      }),
      (c) => c.json({ ok: true, version: VERSION }, 200),
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/v1/status',
        tags: ['meta'],
        description: "Today's AniList usage against this instance's budgets, for self-hosters tuning them.",
        responses: { 200: json(StatusSchema, 'Usage and limits'), 429: errors[429] },
      }),
      async (c) => c.json({ version: VERSION, anilist: await anilist.usage(), aniskip: !!aniskip }, 200),
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/v1/sources',
        tags: ['meta'],
        description: 'Every source with its latest health check (null until the first check ran).',
        responses: { 200: json(z.array(SourceSchema), 'Sources in preference order'), 429: errors[429] },
      }),
      async (c) => {
        const health = await latestHealth(db)
        return c.json(
          [...sources.values()].map((s) => {
            const h = health[s.id]
            return {
              id: s.id,
              name: s.name,
              baseUrl: s.baseUrl,
              health: h ? { ...h, checkedAt: h.checkedAt.toISOString() } : null,
            }
          }),
          200,
        )
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/v1/search',
        tags: ['anime'],
        description: 'Title + synonym search over the local catalog (offline database + daily AniList sync).',
        request: {
          query: z.object({
            q: z.string().trim().min(1).max(200).openapi({ example: 'frieren' }),
            limit: z.coerce.number().int().min(1).max(50).default(20),
          }),
        },
        responses: { 200: json(z.array(CatalogEntrySchema), 'Best first'), 400: errors[400], 429: errors[429] },
      }),
      async (c) => {
        const { q, limit } = c.req.valid('query')
        return c.json(await catalog.search(q, limit), 200)
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/v1/anime/{anilistId}',
        tags: ['anime'],
        description:
          'AniList details (fresh for 24 h for finished shows, 1 h otherwise; an expired copy is served when AniList ' +
          'or the budget says no). `description` is AniList HTML: sanitize it. 503 anilist_cap = budget used and ' +
          'nothing cached.',
        request: { params: AnilistIdParam },
        responses: {
          200: json(AnimeSchema, 'The anime'),
          404: errors[404],
          429: errors[429],
          502: errors[502],
          503: errors[503],
        },
      }),
      async (c) => c.json(await details(c.req.valid('param').anilistId), 200),
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/v1/anime/{anilistId}/episodes',
        tags: ['anime'],
        description: 'Episodes on one source (default: the first source that has the show), in AniList numbering.',
        request: { params: AnilistIdParam, query: SourceQuery },
        responses: { 200: json(EpisodesSchema, 'Episodes'), 404: errors[404], 429: errors[429], 502: errors[502] },
      }),
      async (c) => {
        const { anilistId } = c.req.valid('param')
        const errs: string[] = []
        for (const s of pickSources(c.req.valid('query').source)) {
          try {
            const m = await matcher.match(anilistId, s)
            if (!m.showId) {
              errs.push(`${s.id}: no match`)
              continue
            }
            const showId = m.showId
            const key = `episodes:${s.id}:${showId}`
            let show = await streamCache.get<Awaited<ReturnType<Source['getShow']>>>(key)
            if (!show) {
              show = await s.getShow(showId)
              await streamCache.set(key, show, EPISODES_CACHE_MS)
            }
            const [from, to] = m.episodeRange ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
            // titles/thumbnails from AniList's streamingEpisodes; optional, so an AniList failure costs nothing
            const extras = streamingEpisodeExtras(
              (await anilist.media(anilistId).catch(() => null))?.streamingEpisodes ?? [],
            )
            const episodes = show.episodes
              .filter((e) => e.number >= from && e.number <= to)
              .map((e) => {
                const number = e.number - m.episodeOffset
                const x = extras.get(number)
                const title = e.title || x?.title
                return {
                  number,
                  ...(title ? { title } : {}),
                  ...(x?.thumbnail ? { thumbnail: x.thumbnail } : {}),
                  sub: e.sub,
                  dub: e.dub,
                }
              })
            return c.json({ source: s.id, showId, confidence: m.confidence, episodes }, 200)
          } catch (e) {
            errs.push(`${s.id}: ${(e as Error).message}`)
          }
        }
        throw new ApiError(404, 'no_source', `no source has AniList ${anilistId} (${errs.join('; ')})`)
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/v1/anime/{anilistId}/episodes/{episode}/streams',
        tags: ['anime'],
        security: [{ apiKey: [] }],
        description:
          'Playable streams + subtitles. Every URL points at the relay with a sealed, short-lived token. ' +
          'Needs an API key unless REQUIRE_KEY_FOR_STREAMS=false.',
        request: {
          params: AnilistIdParam.extend({
            episode: z.coerce
              .number()
              .positive()
              .openapi({ param: { name: 'episode', in: 'path' }, example: 1 }),
          }),
          query: SourceQuery.extend({
            audio: AudioSchema.default('sub'),
            viewerIp: z.ipv4().or(z.ipv6()).optional().openapi({
              description: 'API-key callers only: bind the relay URLs to the viewer IP the site saw',
            }),
          }),
        },
        responses: {
          200: json(StreamsSchema, 'Streams'),
          400: errors[400],
          401: errors[401],
          404: errors[404],
          429: errors[429],
        },
      }),
      async (c) => {
        const key = c.get('key')
        if (config.requireKeyForStreams && !key) throw new ApiError(401, 'key_required', 'streams need an API key')
        const { anilistId, episode } = c.req.valid('param')
        const { source, audio, viewerIp } = c.req.valid('query')
        const ip = key ? viewerIp : undefined
        const errs: string[] = []
        for (const s of pickSources(source)) {
          try {
            const r = await matcher.resolveEpisode(anilistId, episode, s)
            const cacheKey = `streams:${s.id}:${r.episodeId}:${audio}`
            let result = await streamCache.get<StreamResult>(cacheKey)
            if (!result) {
              result = await s.getStreams(r.episodeId, { audio: audio as Audio })
              await streamCache.set(cacheKey, result, STREAM_CACHE_MS)
            }
            const expires = Date.now() + config.relayTokenTtlMs
            const servers = result.servers
              .map((sv) => {
                const streams = sv.streams.filter((st) => config.relaySharesEgress || !st.ipLocked)
                const headers = streams[0]?.headers ?? sv.streams[0]?.headers ?? {}
                return {
                  name: sv.name,
                  ...(sv.intro ? { intro: sv.intro } : {}),
                  ...(sv.outro ? { outro: sv.outro } : {}),
                  streams: streams.map((st) => ({
                    url: relayUrl(
                      {
                        u: st.url,
                        k: st.type === 'hls' ? 'playlist' : 'segment',
                        h: st.headers,
                        s: s.id,
                        ...(st.playlistKey ? { x: st.playlistKey } : {}),
                        ...(ip ? { ip } : {}),
                      },
                      st.type === 'hls' ? 'm3u8' : 'mp4',
                      expires,
                    ),
                    type: st.type,
                    quality: st.quality,
                    ...(st.audioLang ? { audioLang: st.audioLang } : {}),
                  })),
                  subtitles: sv.subtitles.map((sub) => ({
                    lang: sub.lang,
                    label: sub.label,
                    format: sub.format,
                    default: sub.default,
                    url: relayUrl(
                      { u: sub.url, k: 'subtitle', h: headers, s: s.id, ...(ip ? { ip } : {}) },
                      sub.format,
                      expires,
                    ),
                  })),
                }
              })
              .filter((sv) => sv.streams.length)
            if (!servers.length) {
              errs.push(`${s.id}: only IP-locked streams (relay doesn't share the API's IP)`)
              continue
            }
            return c.json(
              {
                source: s.id,
                anilistId,
                episode,
                sourceEpisode: r.sourceEpisode,
                audio,
                expiresAt: new Date(expires).toISOString(),
                servers,
              },
              200,
            )
          } catch (e) {
            errs.push(`${s.id}: ${(e as Error).message}`)
          }
        }
        throw new ApiError(
          404,
          'no_streams',
          `no streams for AniList ${anilistId} episode ${episode} (${errs.join('; ')})`,
        )
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/v1/anime/{anilistId}/episodes/{episode}/skip',
        tags: ['anime'],
        description:
          'Opening/ending times from AniSkip (third-party, by MAL ID). For servers without their own intro/outro. ' +
          '`duration` is the stream length in seconds: AniSkip only answers for a matching episode length. ' +
          'source "none" = no times, no MAL ID, or AniSkip disabled.',
        request: {
          params: AnilistIdParam.extend({
            episode: z.coerce
              .number()
              .int()
              .positive()
              .openapi({ param: { name: 'episode', in: 'path' }, example: 1 }),
          }),
          query: z.object({ duration: z.coerce.number().min(0).max(86_400).openapi({ example: 1420 }) }),
        },
        responses: {
          200: json(SkipSchema, 'Skip times'),
          400: errors[400],
          404: errors[404],
          429: errors[429],
          502: errors[502],
          503: errors[503],
        },
      }),
      async (c) => {
        const { anilistId, episode } = c.req.valid('param')
        if (!aniskip) return c.json({ source: 'none' as const }, 200)
        const { idMal } = await details(anilistId)
        if (!idMal) return c.json({ source: 'none' as const }, 200)
        const r = await aniskip.skipTimes(idMal, episode, c.req.valid('query').duration).catch((e) => {
          throw new ApiError(502, 'aniskip', (e as Error).message)
        })
        return c.json(r, 200)
      },
    )

  app.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
    type: 'apiKey',
    in: 'header',
    name: 'x-api-key',
  })
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'RECONSUMΣT.TS API', version: VERSION, license: { name: 'GPL-3.0-or-later' } },
    servers: [{ url: config.publicUrl }],
  })
  app.get('/docs', swaggerUI({ url: '/openapi.json' }))
  app.get('/', (c) => c.redirect('/docs'))
  return routes
}

export type AppType = ReturnType<typeof createApp>
