// The typed client against the real app (in-process, PGlite): if the contract drifts, this stops compiling.
import { describe, expect, it } from 'vitest'
import { setup } from '../../api/test/helpers.ts'
import { createClient, StreamsSchema } from '../src/index.ts'

describe('client', () => {
  it('calls typed routes and the responses match the exported schemas', async () => {
    const { app, key } = await setup()
    const fetch = ((input: string | URL | Request, init?: RequestInit) =>
      app.request(input, init)) as typeof globalThis.fetch
    const api = createClient('https://api.example.org', { apiKey: key, fetch })

    const health = await api.v1.health.$get()
    expect(await health.json()).toEqual({ ok: true, version: '0.4.1' })

    const res = await api.v1.anime[':anilistId'].episodes[':episode'].streams.$get({
      param: { anilistId: '1', episode: '1' },
      query: { audio: 'sub' },
    })
    expect(res.status).toBe(200)
    if (res.status !== 200) return
    const body = await res.json()
    expect(StreamsSchema.parse(body).servers[0]?.streams[0]?.url).toMatch(/^https:\/\/relay\.example\.org\/r\//)
  })
})
