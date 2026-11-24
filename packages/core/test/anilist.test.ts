import { describe, expect, it } from 'vitest'
import {
  AniListCapError,
  createAniList,
  nextSeason,
  streamingEpisodeExtras,
  toCatalogEntry,
} from '../src/anilist/client.ts'
import { FileCatalogStore } from '../src/catalog/file-store.ts'
import { fakeFetcher, fixture, tempDir } from './helpers.ts'

const media = async () => fixture('anilist/__fixtures__/media-119661.json')
const details = async () => fixture('anilist/__fixtures__/details-154587.json')
const NOT_FOUND = JSON.stringify({ errors: [{ message: 'Not Found.', status: 404 }], data: { Media: null } })
const syncPage = async () =>
  JSON.stringify({
    data: { Page: { pageInfo: { hasNextPage: false }, media: [JSON.parse(await media()).data.Media] } },
  })

describe('AniList client', () => {
  it('looks up media by ID, caches it on disk, and counts only real requests', async () => {
    const body = await details()
    const { fetcher, calls } = fakeFetcher((_u, o) => {
      const { variables } = JSON.parse(String(o.body))
      return variables.id === 154587 ? { body } : { status: 404, body: NOT_FOUND }
    })
    const al = createAniList({ fetcher, dir: await tempDir() })

    const m = await al.media(154587)
    expect(m?.title.romaji).toBe('Sousou no Frieren')
    expect(m?.relations.edges.find((e) => e.relationType === 'SEQUEL')?.node).toMatchObject({ id: 182255 })
    expect(m?.relations.edges[0]?.node.coverImage?.large).toMatch(/^https:/)
    expect(calls[0]?.options.method).toBe('POST')
    expect(calls[0]?.options.retry).toMatchObject({ methods: ['POST'] })

    await al.media(154587) // disk cache
    expect(calls).toHaveLength(1)
    expect(await al.media(1)).toBeNull() // AniList's 404 → null, and cached too
    await al.media(1)
    expect(calls).toHaveLength(2)
    expect((await al.usage()).count).toBe(2)
  })

  it('maps the details: main studios first, flat characters and recommendations', async () => {
    const body = await details()
    const { fetcher } = fakeFetcher(() => ({ body }))
    const m = await createAniList({ fetcher, dir: await tempDir() }).media(154587)
    expect(m?.studios[0]).toEqual({ id: 11, name: 'MADHOUSE', isAnimationStudio: true, isMain: true })
    expect(m?.characters).toHaveLength(12)
    expect(m?.characters[0]).toMatchObject({
      name: 'Frieren',
      role: 'MAIN',
      voiceActor: { name: 'Atsumi Tanezaki', nameNative: '種﨑敦美' },
      voiceActorEnglish: { name: 'Mallorie Rodak' },
    })
    expect(m?.recommendations).toHaveLength(12)
    expect(m?.recommendations[0]).toMatchObject({ id: 21827, coverImage: { large: expect.any(String) } })
    expect(m).toMatchObject({ idMal: 52991, isAdult: false, trailer: { site: 'youtube' } })
    expect(m?.tags[0]).toMatchObject({ isSpoiler: false, isAdult: false })
    expect(m?.coverImage.color).toMatch(/^#/)
    expect(JSON.stringify(m).length).toBeLessThan(40_000)
  })

  it('serves the expired answer when AniList fails or the budget is used; errors only with nothing cached', async () => {
    let t = Date.parse('2026-11-24T00:00:00Z')
    let up = true
    const body = await details()
    const { fetcher, calls } = fakeFetcher(() => (up ? { body } : { status: 500, body: '{}' }))
    const al = createAniList({ fetcher, dir: await tempDir(), now: () => new Date(t), dailyCap: 1 })
    await al.media(154587)
    t += 2 * 3_600_000 // FINISHED → fresh for 24 h
    await al.media(154587)
    expect(calls).toHaveLength(1)
    t += 25 * 3_600_000
    up = false
    expect((await al.media(154587))?.title.romaji).toBe('Sousou no Frieren') // AniList 500 → stale
    expect(calls).toHaveLength(2)
    expect((await al.media(154587))?.id).toBe(154587) // the new day's cap (1) is used → stale, no request
    expect(calls).toHaveLength(2)
    await expect(al.media(99)).rejects.toBeInstanceOf(AniListCapError) // nothing cached → error
  })

  it('keeps on-demand lookups under the per-minute budget', async () => {
    let t = Date.parse('2026-11-24T00:00:00Z')
    const { fetcher } = fakeFetcher(() => ({ status: 404, body: NOT_FOUND }))
    const al = createAniList({ fetcher, dir: await tempDir(), now: () => new Date(t), perMinute: 2 })
    await al.media(1)
    await al.media(2)
    await expect(al.media(3)).rejects.toThrow(/per-minute/)
    t += 61_000
    await al.media(3)
    expect(await al.usage()).toMatchObject({ count: 3, lastMinute: 1, perMinute: 2 })
  })

  it('shares one request between concurrent lookups of the same anime', async () => {
    const body = await details()
    const { fetcher, calls } = fakeFetcher(() => ({ body }))
    const al = createAniList({ fetcher, dir: await tempDir() })
    const [a, b, c] = await Promise.all([al.media(154587), al.media(154587), al.media(154587)])
    expect(calls).toHaveLength(1)
    expect(a?.id).toBe(154587)
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('backs off globally on X-RateLimit-Remaining 0 or a 429: page views fail fast, the sync waits', async () => {
    const reset = Math.floor(Date.now() / 1000) + 30
    let reply: { status: number; body: string; headers: Record<string, string> } = {
      status: 404,
      body: NOT_FOUND,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    }
    const page = await syncPage()
    const { fetcher } = fakeFetcher((_u, o) => (String(o.body).includes('Page(page') ? { body: page } : reply))
    const waits: number[] = []
    const dir = await tempDir()
    const al = createAniList({ fetcher, dir, sleep: async (ms) => void waits.push(ms) })
    await al.media(1)
    await expect(al.media(2)).rejects.toThrow(/slow down/)
    expect((await al.usage()).pausedUntil).not.toBeNull()
    await al.sync(new FileCatalogStore(dir))
    expect(waits[0]).toBeGreaterThan(25_000)

    reply = {
      status: 429,
      body: '{"errors":[{"message":"Too Many Requests.","status":429}]}',
      headers: { 'retry-after': '40' },
    }
    const al2 = createAniList({ fetcher, dir: await tempDir() })
    await expect(al2.media(1)).rejects.toThrow(/Too Many/)
    await expect(al2.media(2)).rejects.toThrow(/slow down/)
  })

  it('gives the sync its own small budget', async () => {
    const page = await syncPage()
    const { fetcher } = fakeFetcher(() => ({ body: page }))
    const dir = await tempDir()
    const al = createAniList({ fetcher, dir, dailyCap: 1 })
    await al.sync(new FileCatalogStore(dir)) // 3 requests although the on-demand cap is 1
    expect(await al.usage()).toMatchObject({ count: 0, sync: { count: 3, cap: 20 } })
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

  it('streamingEpisodeExtras: titles + thumbnails by episode number, ambiguous numbers dropped', async () => {
    const x = streamingEpisodeExtras(JSON.parse(await details()).data.Media.streamingEpisodes)
    expect(x.get(1)).toEqual({ title: "The Journey's End", thumbnail: expect.stringMatching(/^https:/) })
    expect(x.size).toBe(28)
    const odd = streamingEpisodeExtras([
      { title: 'Episode 2 - A', thumbnail: null, url: null, site: null },
      { title: 'Episode 2 - B', thumbnail: null, url: null, site: null },
      { title: 'Episode 3', thumbnail: 't3', url: null, site: null },
      { title: 'Special - Recap', thumbnail: 'x', url: null, site: null },
    ])
    expect([...odd]).toEqual([[3, { thumbnail: 't3' }]])
  })

  it('toCatalogEntry maps AniList vocabulary onto the catalog one', async () => {
    const e = toCatalogEntry(JSON.parse(await media()).data.Media)
    expect(e).toMatchObject({
      anilistId: 119661,
      malId: 42203,
      type: 'TV',
      status: 'FINISHED',
      episodes: 12,
      year: 2021,
    })
    expect(e.synonyms[0]).toBe('Re:ZERO -Starting Life in Another World- Season 2 Part 2')
    expect(toCatalogEntry({ ...JSON.parse(await media()).data.Media, isAdult: true }).isAdult).toBe(true)
  })
})
