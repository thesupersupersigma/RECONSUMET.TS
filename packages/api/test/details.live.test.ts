// Live: anime details, episode extras and skip times against real AniList, AniSkip and the sources.
// A long-running show, a movie, whatever is most popular and airing right now, and an episode AniSkip knows.
import { createAniList, createAniSkip, createSources } from '@reconsumet/core'
import { connectPglite, migrate, pgCache } from '@reconsumet/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { env } from './helpers.ts'

let api: (path: string) => Promise<Response>
let cleanup = async () => {}

beforeAll(async () => {
  const db = await connectPglite()
  await migrate(db)
  const { fetcher, sources } = createSources()
  const app = createApp({
    config: env(),
    db,
    sources,
    anilist: createAniList({ fetcher, cache: pgCache(db, 'anilist') }),
    aniskip: createAniSkip({ fetcher, cache: pgCache(db, 'aniskip') }),
    remoteAddr: () => '127.0.0.1',
  })
  api = async (path) => app.request(path)
  cleanup = async () => {
    await fetcher.close()
    await db.close()
  }
})
afterAll(() => cleanup())

async function details(id: number) {
  const res = await api(`/v1/anime/${id}`)
  const text = await res.text()
  expect(res.status, text).toBe(200)
  console.log(`anime ${id}: ${text.length} bytes`)
  const m = JSON.parse(text)
  expect(m.description).toBeTruthy()
  expect(m.coverImage.extraLarge).toMatch(/^https:/)
  expect(m.genres.length).toBeGreaterThan(0)
  expect(m.studios.length).toBeGreaterThan(0)
  expect(m.characters.length).toBeGreaterThan(0)
  expect(m.characters.length).toBeLessThanOrEqual(12)
  expect(m.recommendations.length).toBeLessThanOrEqual(12)
  expect(text.length).toBeLessThan(150_000)
  return m
}

describe('anime details', () => {
  it('long-running: One Piece', async () => {
    const m = await details(21)
    expect(m.relations.edges.length).toBeGreaterThan(10)
    expect(m.relations.edges[0].node).toHaveProperty('coverImage')
    expect(m.characters[0].role).toBe('MAIN')
  })

  it('movie: Kimi no Na wa.', async () => {
    const m = await details(21519)
    expect(m.format).toBe('MOVIE')
    expect(m.studios[0].isMain).toBe(true)
  })

  it('airing: the top trending show airing now (not One Piece)', async () => {
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        query: 'query { Page(perPage: 5) { media(type: ANIME, status: RELEASING, sort: TRENDING_DESC) { id } } }',
      }),
    })
    const { data } = (await r.json()) as { data: { Page: { media: { id: number }[] } } }
    const id = data.Page.media.find((x) => x.id !== 21)!.id // not One Piece again
    const m = await details(id)
    expect(m.status).toBe('RELEASING')
  })

  it('episodes carry AniList thumbnails (Frieren)', async () => {
    const res = await api('/v1/anime/154587/episodes')
    const text = await res.text()
    expect(res.status, text).toBe(200)
    const { episodes } = JSON.parse(text) as { episodes: { number: number; title?: string; thumbnail?: string }[] }
    expect(episodes.length).toBeGreaterThan(20)
    expect(episodes.filter((e) => e.thumbnail).length).toBeGreaterThan(20)
    expect(episodes.every((e) => e.title)).toBe(true)
  })

  it('skip times: Death Note episode 1 (AniSkip knows it), and none for a wrong length', async () => {
    const hit = await (await api('/v1/anime/1535/episodes/1/skip?duration=1377')).json()
    expect(hit).toMatchObject({ source: 'aniskip', intro: { start: expect.any(Number) } })
    const miss = await (await api('/v1/anime/1535/episodes/1/skip?duration=400')).json()
    expect(miss).toEqual({ source: 'none' })
    const status = (await (await api('/v1/status')).json()) as { anilist: { count: number } }
    expect(status.anilist.count).toBeGreaterThan(0)
  })
})
