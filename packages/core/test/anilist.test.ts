import { describe, expect, it } from 'vitest'
import { AniListCapError, createAniList, nextSeason, toCatalogEntry } from '../src/anilist/client.ts'
import { FileCatalogStore } from '../src/catalog/file-store.ts'
import { fakeFetcher, fixture, tempDir } from './helpers.ts'

const media = async () => fixture('anilist/__fixtures__/media-119661.json')
const NOT_FOUND = JSON.stringify({ errors: [{ message: 'Not Found.', status: 404 }], data: { Media: null } })

describe('AniList client', () => {
  it('looks up media by ID, caches it on disk, and counts only real requests', async () => {
    const body = await media()
    const { fetcher, calls } = fakeFetcher((_u, o) => {
      const { variables } = JSON.parse(String(o.body))
      return variables.id === 119661 ? { body } : { status: 404, body: NOT_FOUND }
    })
    const al = createAniList({ fetcher, dir: await tempDir() })

    const m = await al.media(119661)
    expect(m?.title.romaji).toBe('Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2')
    expect(m?.relations?.edges.find((e) => e.relationType === 'PREQUEL')?.node).toMatchObject({ id: 108632, episodes: 13 })
    expect(calls[0]?.options.method).toBe('POST')
    expect(calls[0]?.options.retry).toMatchObject({ methods: ['POST'] })

    await al.media(119661) // disk cache
    expect(calls).toHaveLength(1)
    expect(await al.media(1)).toBeNull() // AniList's 404 → null, and cached too
    await al.media(1)
    expect(calls).toHaveLength(2)
    expect((await al.usage()).count).toBe(2)
  })

  it('stops at the daily cap', async () => {
    const { fetcher } = fakeFetcher(() => ({ body: NOT_FOUND, status: 404 }))
    const al = createAniList({ fetcher, dir: await tempDir(), dailyCap: 1 })
    await al.media(1)
    await expect(al.media(2)).rejects.toBeInstanceOf(AniListCapError)
  })

  it('waits for X-RateLimit-Reset when X-RateLimit-Remaining runs out', async () => {
    const reset = Math.floor(Date.now() / 1000) + 30
    const { fetcher } = fakeFetcher(() => ({
      status: 404,
      body: NOT_FOUND,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    }))
    const waits: number[] = []
    const al = createAniList({ fetcher, dir: await tempDir(), sleep: async (ms) => void waits.push(ms) })
    await al.media(1)
    await al.media(2)
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(25_000)
  })

  it('syncs airing / upcoming / updated pages into the catalog', async () => {
    const m = JSON.parse(await media()).data.Media
    const seen: Record<string, unknown>[] = []
    const { fetcher } = fakeFetcher((_u, o) => {
      const { variables } = JSON.parse(String(o.body))
      seen.push(variables)
      return { body: JSON.stringify({ data: { Page: { pageInfo: { hasNextPage: false }, media: [m] } } }) }
    })
    const dir = await tempDir()
    const al = createAniList({ fetcher, dir, now: () => new Date('2026-11-24T00:00:00Z') })
    const store = new FileCatalogStore(dir)
    const r = await al.sync(store)
    expect(r.counts).toEqual({ airing: 1, upcoming: 1, updated: 1 })
    expect(seen.map((v) => v.perPage)).toEqual([50, 50, 50]) // hasNextPage false: no second airing page
    expect(seen[1]).toMatchObject({ season: 'WINTER', seasonYear: 2027 })
    expect((await store.get({ anilistId: 119661 }))?.synonyms).toContain('Re:Zero kara Hajimeru Isekai Seikatsu (2021)')
  })
})

describe('helpers', () => {
  it('nextSeason', () => {
    expect(nextSeason(new Date('2026-11-24'))).toEqual({ season: 'WINTER', year: 2027 })
    expect(nextSeason(new Date('2026-01-10'))).toEqual({ season: 'SPRING', year: 2026 })
    expect(nextSeason(new Date('2026-08-01'))).toEqual({ season: 'FALL', year: 2026 })
  })

  it('toCatalogEntry maps AniList vocabulary onto the catalog one', async () => {
    const e = toCatalogEntry(JSON.parse(await media()).data.Media)
    expect(e).toMatchObject({ anilistId: 119661, malId: 42203, type: 'TV', status: 'FINISHED', episodes: 12, year: 2021 })
    expect(e.synonyms[0]).toBe('Re:ZERO -Starting Life in Another World- Season 2 Part 2')
  })
})
