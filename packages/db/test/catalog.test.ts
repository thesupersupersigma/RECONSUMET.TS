import { describe, expect, it } from 'vitest'
import { PgCatalogStore } from '../src/index.ts'
import { entry, freshDb } from './helpers.ts'

describe('PgCatalogStore', () => {
  it('gets by any ID, searches normalized titles, merges upserts', async () => {
    const store = new PgCatalogStore(await freshDb())
    await store.upsert([
      entry({ anilistId: 1, malId: 10, title: 'Sousou no Frieren', synonyms: ['Frieren: Beyond Journey’s End'] }),
      entry({ anidbId: 99, title: 'Some OVA', type: 'OVA', isAdult: true }),
      entry({ anilistId: 2, title: 'Airing Show', status: 'ONGOING' }),
    ])
    expect(await store.get({ malId: 10 })).toEqual(
      entry({ anilistId: 1, malId: 10, title: 'Sousou no Frieren', synonyms: ['Frieren: Beyond Journey’s End'] }),
    )
    expect(await store.get({ anidbId: 99 })).toMatchObject({ type: 'OVA', isAdult: true })
    expect((await store.get({ anilistId: 404, malId: 10 }))?.anilistId).toBe(1) // falls through to the next ID
    expect(await store.get({ kitsuId: 5 })).toBeUndefined()
    expect((await store.search('frieren beyond journeys end'))[0]?.anilistId).toBe(1)
    expect((await store.search('FRIEREN'))[0]?.anilistId).toBe(1)
    expect(await store.search('  !! ')).toEqual([])

    // AniList sync data merges into the offline entry found by MAL ID
    await store.upsert([
      entry({ anilistId: 1, malId: 10, title: 'Sousou no Frieren', synonyms: ['Frieren'], episodes: 28, year: 0 }),
    ])
    const merged = await store.get({ anilistId: 1 })
    expect(merged?.episodes).toBe(28)
    expect(merged?.year).toBe(2020) // 0 = empty, doesn't overwrite
    expect(merged?.synonyms).toEqual(['Frieren: Beyond Journey’s End', 'Frieren'])
    expect(await store.count()).toBe(3)
    expect((await store.listAiring()).map((e) => e.anilistId)).toEqual([2])

    expect(await store.getMeta('k')).toBeUndefined()
    await store.setMeta('k', { v: 1 })
    await store.setMeta('k', { v: 2 })
    expect(await store.getMeta('k')).toEqual({ v: 2 })
  })

  it('ranks exact > prefix > all words > fuzzy, newest first on ties', async () => {
    const store = new PgCatalogStore(await freshDb())
    await store.upsert([
      entry({ anilistId: 1, title: 'Frieren Movie Special', year: 2025 }),
      entry({ anilistId: 2, title: 'Sousou no Frieren', synonyms: ['Frieren'], year: 2023 }),
      entry({ anilistId: 3, title: 'Frieren 2', year: 2026 }),
      entry({ anilistId: 4, title: 'Frieren', year: 2010 }),
      entry({ anilistId: 5, title: 'Unrelated', year: 2030 }),
    ])
    expect((await store.search('frieren')).map((e) => e.anilistId)).toEqual([2, 4, 3, 1])
    expect((await store.search('movie frieren')).map((e) => e.anilistId)).toEqual([1])
    expect(await store.search('frieren', 2)).toHaveLength(2)
  })

  it('finds misspellings by trigram similarity', async () => {
    const store = new PgCatalogStore(await freshDb())
    await store.upsert([
      entry({ anilistId: 1, title: 'Sousou no Frieren', synonyms: ['Frieren: Beyond Journey’s End'] }),
      entry({ anilistId: 2, title: 'Shingeki no Kyojin', synonyms: ['Attack on Titan'] }),
    ])
    expect((await store.search('freiren beyond journeys')).map((e) => e.anilistId)).toEqual([1])
    expect((await store.search('sosou no frieren')).map((e) => e.anilistId)).toEqual([1])
    expect((await store.search('atack on titan')).map((e) => e.anilistId)).toEqual([2])
  })

  it('merges two incoming entries sharing an ID, and an entry spanning two rows', async () => {
    const store = new PgCatalogStore(await freshDb())
    await store.upsert([
      entry({ malId: 10, title: 'A', synonyms: ['a1'] }),
      entry({ malId: 10, anilistId: 1, title: 'A', synonyms: ['a2'], episodes: 24 }),
    ])
    expect(await store.count()).toBe(1)
    expect(await store.get({ anilistId: 1 })).toMatchObject({ malId: 10, episodes: 24, synonyms: ['a1', 'a2'] })

    // row B owns MAL 20; an update for AniList 1 says MAL 20 belongs to it: it moves, like the file store's index
    await store.upsert([entry({ malId: 20, kitsuId: 7, title: 'B' })])
    await store.upsert([entry({ anilistId: 1, malId: 20, title: 'A' })])
    expect(await store.count()).toBe(2)
    expect((await store.get({ malId: 20 }))?.anilistId).toBe(1)
    expect((await store.get({ kitsuId: 7 }))?.malId).toBeUndefined()
  })

  it('upserts thousands of entries in batches, quickly', async () => {
    const store = new PgCatalogStore(await freshDb())
    const many = Array.from({ length: 5000 }, (_, i) =>
      entry({ anilistId: i + 1, malId: i + 100_000, title: `Show number ${i}`, synonyms: [`Alt ${i}`] }),
    )
    const t = performance.now()
    await store.upsert(many)
    await store.upsert(many.map((e) => ({ ...e, episodes: 13 }))) // all merges
    expect(performance.now() - t).toBeLessThan(10_000)
    expect(await store.count()).toBe(5000)
    expect((await store.get({ malId: 104_999 }))?.episodes).toBe(13)
  })
})
