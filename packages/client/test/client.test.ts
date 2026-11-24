// The typed client against the real app (in-process, PGlite): if the contract drifts, this stops compiling.
import { describe, expect, it } from 'vitest'
import { VERSION } from '../../api/src/app.ts'
import { AnimeSchema, SkipSchema, StreamsSchema } from '../../api/src/schemas.ts'
import { setup } from '../../api/test/helpers.ts'
import { createClient } from '../src/index.ts'

describe('client', () => {
  it('calls typed routes and the responses match the exported schemas', async () => {
    const { app, key } = await setup()
    const fetch = ((input: string | URL | Request, init?: RequestInit) =>
      app.request(input, init)) as typeof globalThis.fetch
    const api = createClient('https://api.example.org', { apiKey: key, fetch })

    const health = await api.v1.health.$get()
    expect(await health.json()).toEqual({ ok: true, version: VERSION })

    const res = await api.v1.anime[':anilistId'].episodes[':episode'].streams.$get({
      param: { anilistId: '1', episode: '1' },
      query: { audio: 'sub' },
    })
    expect(res.status).toBe(200)
    if (res.status !== 200) return
    const body = await res.json()
    expect(StreamsSchema.parse(body).servers[0]?.streams[0]?.url).toMatch(/^https:\/\/relay\.example\.org\/r\//)

    const anime = await api.v1.anime[':anilistId'].$get({ param: { anilistId: '1' } })
    if (anime.status !== 200) throw new Error(`anime: ${anime.status}`)
    const a = await anime.json()
    const voice: string | null | undefined = a.characters[0]?.voiceActor?.name // the 0.6 fields are typed
    expect(voice).toBeUndefined()
    expect(AnimeSchema.parse(a).streamingEpisodes).toHaveLength(2)

    const skip = await api.v1.anime[':anilistId'].episodes[':episode'].skip.$get({
      param: { anilistId: '2', episode: '1' },
      query: { duration: '1400' },
    })
    if (skip.status !== 200) throw new Error(`skip: ${skip.status}`)
    expect(SkipSchema.parse(await skip.json()).source).toBe('aniskip')
  })
})
