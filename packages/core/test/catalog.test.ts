import { describe, expect, it } from 'vitest'
import { FileCatalogStore } from '../src/catalog/file-store.ts'
import { normalizeManami, updateOfflineDb } from '../src/catalog/offline-db.ts'
import type { CatalogEntry } from '../src/catalog/types.ts'
import { fakeFetcher, fixture, tempDir } from './helpers.ts'

const sample = async () => fixture('catalog/__fixtures__/offline-db-sample.json')

describe('normalizeManami', () => {
  it('pulls the cross-IDs out of the source URLs and keeps entries without an AniList ID', async () => {
    const { data } = JSON.parse(await sample())
    const [jjk, noAnilist] = data.map(normalizeManami)
    expect(jjk).toMatchObject({
      anilistId: 145064,
      malId: 51009,
      kitsuId: 45857,
      anidbId: 17196,
      title: 'Jujutsu Kaisen 2nd Season',
      type: 'TV',
      episodes: 23,
      status: 'FINISHED',
      season: 'SUMMER',
      year: 2023,
      duration: 1380,
    })
    expect(jjk.synonyms).toContain('Jujutsu Kaisen (2023)')
    expect(noAnilist.anilistId).toBeUndefined()
    expect(noAnilist.anidbId).toBeTypeOf('number')
  })
})

describe('FileCatalogStore', () => {
  const entry = (e: Partial<CatalogEntry>): CatalogEntry => ({
    title: 'x',
    synonyms: [],
    type: 'TV',
    episodes: 12,
    status: 'FINISHED',
    season: null,
    year: 2020,
    picture: null,
    duration: null,
    ...e,
  })

  it('gets by any ID, searches normalized titles, merges upserts, persists', async () => {
    const dir = await tempDir()
    const store = new FileCatalogStore(dir)
    await store.upsert([
      entry({ anilistId: 1, malId: 10, title: 'Sousou no Frieren', synonyms: ['Frieren: Beyond Journey’s End'] }),
      entry({ anidbId: 99, title: 'Some OVA', type: 'OVA' }),
      entry({ anilistId: 2, title: 'Airing Show', status: 'ONGOING' }),
    ])
    expect((await store.get({ malId: 10 }))?.title).toBe('Sousou no Frieren')
    expect((await store.get({ anidbId: 99 }))?.type).toBe('OVA')
    expect((await store.search('frieren beyond journeys end'))[0]?.anilistId).toBe(1)
    expect((await store.search('FRIEREN'))[0]?.anilistId).toBe(1)

    // AniList sync data merges into the offline entry found by MAL ID
    await store.upsert([
      entry({ anilistId: 1, malId: 10, title: 'Sousou no Frieren', synonyms: ['Frieren'], episodes: 28 }),
    ])
    const merged = await store.get({ anilistId: 1 })
    expect(merged?.episodes).toBe(28)
    expect(merged?.synonyms).toEqual(['Frieren: Beyond Journey’s End', 'Frieren'])
    expect(await store.count()).toBe(3)
    expect((await store.listAiring()).map((e) => e.anilistId)).toEqual([2])

    await store.setMeta('k', { v: 1 })
    const reopened = new FileCatalogStore(dir)
    expect(await reopened.count()).toBe(3)
    expect(await reopened.getMeta('k')).toEqual({ v: 1 })
  })
})

describe('updateOfflineDb', () => {
  it('imports, then skips when the ETag or lastUpdate is unchanged', async () => {
    const body = await sample()
    const { fetcher, calls } = fakeFetcher((_u, o) =>
      o.headers?.['if-none-match'] === '"v1"' ? { status: 304, body: '' } : { body, headers: { etag: '"v1"' } },
    )
    const store = new FileCatalogStore(await tempDir())

    const first = await updateOfflineDb(fetcher, store)
    expect(first.skipped).toBe(false)
    expect(first.meta).toMatchObject({ etag: '"v1"', entries: 3 })
    expect(await store.count()).toBe(3)

    const second = await updateOfflineDb(fetcher, store)
    expect(second.skipped).toBe(true)
    expect(calls[1]?.options.headers?.['if-none-match']).toBe('"v1"')

    // forced: downloads again, same lastUpdate is still imported
    expect((await updateOfflineDb(fetcher, store, { force: true })).skipped).toBe(false)
  })

  it('skips on an unchanged lastUpdate when the server ignores the ETag', async () => {
    const body = await sample()
    const { fetcher } = fakeFetcher(() => ({ body }))
    const store = new FileCatalogStore(await tempDir())
    await updateOfflineDb(fetcher, store)
    expect((await updateOfflineDb(fetcher, store)).skipped).toBe(true)
  })
})
