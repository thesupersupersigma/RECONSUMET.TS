import { openToken } from '@reconsumet/core'
import { latestHealth, PgCatalogStore, runJobIfDue } from '@reconsumet/db'
import { describe, expect, it } from 'vitest'
import { jobList } from '../src/jobs.ts'
import { SECRET, setup, UPSTREAM } from './helpers.ts'

const get = (app: Awaited<ReturnType<typeof setup>>['app'], path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers })

describe('meta routes', () => {
  it('health, OpenAPI document and docs UI', async () => {
    const { app } = await setup()
    expect(await (await get(app, '/v1/health')).json()).toEqual({ ok: true, version: '0.4.0' })
    const doc = (await (await get(app, '/openapi.json', { host: 'evil.example' })).json()) as {
      servers: { url: string }[]
      paths: Record<string, unknown>
    }
    expect(doc.servers).toEqual([{ url: 'https://api.example.org' }]) // config, never the Host header
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/health',
        '/v1/sources',
        '/v1/search',
        '/v1/anime/{anilistId}',
        '/v1/anime/{anilistId}/episodes',
        '/v1/anime/{anilistId}/episodes/{episode}/streams',
      ]),
    )
    expect((await get(app, '/docs')).status).toBe(200)
  })

  it('one JSON error format: validation, 404, unknown route', async () => {
    const { app } = await setup()
    const bad = await get(app, '/v1/search')
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_request')
    const missing = await get(app, '/v1/anime/999')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: { code: 'not_found', message: 'no anime 999 on AniList' } })
    expect(((await (await get(app, '/nope')).json()) as { error: { code: string } }).error.code).toBe('not_found')
    expect((await get(app, '/v1/anime/abc')).status).toBe(400)
  })

  it('search goes through the Postgres catalog', async () => {
    const { app, db } = await setup()
    await new PgCatalogStore(db).upsert([
      {
        anilistId: 154587,
        title: 'Sousou no Frieren',
        synonyms: ["Frieren: Beyond Journey's End"],
        type: 'TV',
        episodes: 28,
        status: 'FINISHED',
        season: 'FALL',
        year: 2023,
        picture: null,
        duration: 1440,
      },
    ])
    const hits = (await (await get(app, '/v1/search?q=frieren')).json()) as { anilistId: number }[]
    expect(hits[0]?.anilistId).toBe(154587)
  })

  it('sources carry the latest health check from the job', async () => {
    const { app, db, source } = await setup()
    expect(((await (await get(app, '/v1/sources')).json()) as { health: unknown }[])[0]?.health).toBeNull()
    const job = jobList({
      db,
      fetcher: {} as never,
      catalog: new PgCatalogStore(db),
      anilist: {} as never,
      sources: new Map([[source.id, source]]),
    }).find((j) => j.name === 'source-health')!
    expect((await runJobIfDue(db, job.name, job.every, job.run)).ran).toBe(true)
    expect((await runJobIfDue(db, job.name, job.every, job.run)).ran).toBe(false) // not due again yet
    expect((await latestHealth(db)).fake?.ok).toBe(true)
    const [s] = (await (await get(app, '/v1/sources')).json()) as { id: string; health: { ok: boolean } }[]
    expect(s).toMatchObject({ id: 'fake', health: { ok: true } })
  })
})

describe('episodes + streams', () => {
  it('episodes come back in AniList numbering (offset + range applied)', async () => {
    const { app } = await setup()
    const r = (await (await get(app, '/v1/anime/1/episodes')).json()) as { episodes: { number: number }[] }
    expect(r.episodes.map((e) => e.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    expect((await get(app, '/v1/anime/1/episodes?source=nope')).status).toBe(400)
  })

  it('streams need a key; a bad key is a 401', async () => {
    const { app } = await setup()
    expect((await get(app, '/v1/anime/1/episodes/1/streams')).status).toBe(401)
    expect((await get(app, '/v1/anime/1/episodes/1/streams', { 'x-api-key': 'rk_nope' })).status).toBe(401)
    expect((await get(app, '/v1/health', { authorization: 'Bearer rk_nope' })).status).toBe(401)
  })

  it('every URL is a sealed relay URL; the upstream never shows', async () => {
    const { app, key, source } = await setup()
    const res = await get(app, '/v1/anime/1/episodes/2/streams?audio=dub&viewerIp=198.51.100.7', { 'x-api-key': key })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(UPSTREAM)
    expect(text).not.toContain('flix.example')
    const body = JSON.parse(text) as {
      sourceEpisode: number
      servers: { name: string; streams: { url: string }[]; subtitles: { url: string }[] }[]
    }
    expect(body.sourceEpisode).toBe(14)
    expect(source.calls).toEqual(['show/14:dub'])
    const [hd1, hd2] = body.servers
    const token = (url: string) => {
      const m = url.match(/^https:\/\/relay\.example\.org\/r\/([\w-]+)\.(\w+)$/)
      expect(m).not.toBeNull()
      return { ...openToken(m![1]!, [SECRET])!, ext: m![2] }
    }
    expect(token(hd1!.streams[0]!.url)).toMatchObject({
      k: 'playlist',
      ext: 'm3u8',
      x: 'a2V5',
      s: 'fake',
      ip: '198.51.100.7',
      h: { referer: 'https://flix.example/' },
    })
    const sub = token(hd2!.subtitles[0]!.url)
    expect(sub).toMatchObject({ k: 'subtitle', ext: 'vtt', u: `https://${UPSTREAM}/subs/en.vtt` })
    expect(sub.e - Date.now()).toBeGreaterThan(9 * 60_000)
    expect(sub.e - Date.now()).toBeLessThanOrEqual(10 * 60_000)

    // the upstream answer is cached briefly: a second call doesn't hit the source
    await get(app, '/v1/anime/1/episodes/2/streams?audio=dub', { 'x-api-key': key })
    expect(source.calls).toHaveLength(1)
  })

  it('drops IP-locked (HD-1) streams once the relay has its own IP', async () => {
    const { app, key } = await setup({ RELAY_SHARES_EGRESS_WITH_API: 'false' })
    const body = (await (await get(app, '/v1/anime/1/episodes/1/streams', { 'x-api-key': key })).json()) as {
      servers: { name: string }[]
    }
    expect(body.servers.map((s) => s.name)).toEqual(['HD-2'])
  })

  it('REQUIRE_KEY_FOR_STREAMS=false opens streams to anyone (no viewer binding without a key)', async () => {
    const { app } = await setup({ REQUIRE_KEY_FOR_STREAMS: 'false' })
    const body = (await (await get(app, '/v1/anime/1/episodes/1/streams?viewerIp=1.2.3.4')).json()) as {
      servers: { streams: { url: string }[] }[]
    }
    const t = body.servers[0]!.streams[0]!.url.match(/\/r\/([\w-]+)\./)![1]!
    expect(openToken(t, [SECRET])?.ip).toBeUndefined()
  })

  it('a missing episode is a 404 in the error format', async () => {
    const { app, key } = await setup()
    const res = await get(app, '/v1/anime/1/episodes/13/streams', { 'x-api-key': key })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('no_streams')
  })
})

describe('rate limits', () => {
  it('per IP without a key, per key with one', async () => {
    const { app, key } = await setup({ RATE_LIMIT_IP_PER_MIN: '2', RATE_LIMIT_KEY_PER_MIN: '3' })
    expect((await get(app, '/v1/health')).status).toBe(200)
    expect((await get(app, '/v1/health')).status).toBe(200)
    const limited = await get(app, '/v1/health')
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++) expect((await get(app, '/v1/health', { 'x-api-key': key })).status).toBe(200)
    expect((await get(app, '/v1/health', { 'x-api-key': key })).status).toBe(429)
  })

  it('X-Forwarded-For only counts from a trusted proxy', async () => {
    const { app, state } = await setup({ RATE_LIMIT_IP_PER_MIN: '1', TRUSTED_PROXIES: '10.0.0.0/8' })
    // untrusted peer: spoofed headers don't buy a new bucket
    expect((await get(app, '/v1/health', { 'x-forwarded-for': '1.1.1.1' })).status).toBe(200)
    expect((await get(app, '/v1/health', { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429)
    // behind the trusted proxy every viewer has their own bucket
    state.remote = '10.1.2.3'
    expect((await get(app, '/v1/health', { 'x-forwarded-for': '1.1.1.1' })).status).toBe(200)
    expect((await get(app, '/v1/health', { 'x-forwarded-for': '2.2.2.2' })).status).toBe(200)
    expect((await get(app, '/v1/health', { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429)
  })
})

describe('config', () => {
  it('refuses a short RELAY_SECRET and relative URLs', async () => {
    const { loadConfig } = await import('../src/config.ts')
    const base = { DATABASE_URL: 'x', PUBLIC_URL: 'https://a.example', RELAY_PUBLIC_URL: 'https://r.example' }
    expect(() => loadConfig({ ...base, RELAY_SECRET: 'short' })).toThrow(/RELAY_SECRET/)
    expect(() => loadConfig({ ...base, RELAY_SECRET: SECRET, PUBLIC_URL: '/api' })).toThrow(/PUBLIC_URL/)
  })
})
