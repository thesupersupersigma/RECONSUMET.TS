import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  connect,
  createApiKey,
  latestHealth,
  migrate,
  PgCatalogStore,
  pgCache,
  pgMappingStore,
  pruneCache,
  recordHealth,
  revokeApiKey,
  runJobIfDue,
  schema,
  verifyApiKey,
} from '../src/index.ts'
import { entry } from './helpers.ts'

// Smoke checks against a real Postgres: DATABASE_URL=postgres://... pnpm test:live. Its rows use unique IDs/names and are deleted after.
const url = process.env.DATABASE_URL
const tag = `live-${Date.now()}`
const base = 900_000_000 + (Date.now() % 1_000_000) * 10 // far above real AniList/MAL IDs
const id = (n: number) => base + n

describe.skipIf(!url)('postgres (live)', () => {
  // postgres.js connects lazily, so the placeholder never dials out when skipped
  const a = connect(url ?? 'postgres://skipped')
  const b = connect(url ?? 'postgres://skipped')
  afterAll(async () => {
    const { apiKeys, cache, catalog, jobRuns, mappings, sourceHealth } = schema
    await a.orm.delete(catalog).where(eq(catalog.malId, id(2)))
    await a.orm.delete(mappings).where(eq(mappings.sourceId, tag))
    await a.orm.delete(cache).where(eq(cache.ns, tag))
    await a.orm.delete(apiKeys).where(eq(apiKeys.name, tag))
    await a.orm.delete(sourceHealth).where(eq(sourceHealth.sourceId, tag))
    await a.orm.delete(jobRuns).where(eq(jobRuns.name, tag))
    await Promise.all([a.close(), b.close()])
  })

  it('migrates concurrently from two pools, idempotently', async () => {
    await Promise.all([migrate(a), migrate(b)])
    await migrate(a)
  })

  it('advisory locks exclude another session', async () => {
    const inner = await a.withLock(tag, () => b.withLock(tag, async () => 'b'))
    expect(inner).toBeUndefined()
    expect(await b.withLock(tag, async () => 'b')).toBe('b')
  })

  it('catalog, mappings, cache, keys, health, jobs', async () => {
    const store = new PgCatalogStore(a)
    await store.upsert([
      entry({
        anilistId: id(1),
        malId: id(2),
        title: `Sousou no Frieren ${tag}`,
        synonyms: ['Frieren: Beyond Journey’s End'],
      }),
    ])
    await store.upsert([
      entry({ malId: id(2), title: `Sousou no Frieren ${tag}`, synonyms: ['Frieren'], episodes: 28 }),
    ])
    expect(await store.get({ anilistId: id(1) })).toMatchObject({
      episodes: 28,
      synonyms: ['Frieren: Beyond Journey’s End', 'Frieren'],
    })
    expect((await store.search(`sousou no freiren ${tag}`)).map((e) => e.anilistId)).toContain(id(1))

    const maps = pgMappingStore(a)
    await maps.set({ sourceId: tag, anilistId: 1, showId: 's', confidence: 1, episodeOffset: 0, reasons: [] })
    await maps.setOverride(tag, 1, { showId: null, note: 'n' })
    expect((await maps.get(tag, 1))?.result.showId).toBe('s')
    expect(await maps.override(tag, 1)).toEqual({ showId: null, note: 'n' })
    await maps.deleteOverride(tag, 1)

    const cache = pgCache(a, tag)
    await cache.set('k', null, 60_000)
    await cache.set('gone', 1, -1)
    expect(await cache.get('k')).toBeNull()
    expect(await cache.get('gone')).toBeUndefined()
    expect(await pruneCache(a)).toBeGreaterThanOrEqual(1)

    const key = await createApiKey(a, tag, 60)
    expect(await verifyApiKey(b, key.key)).toMatchObject({ name: tag, rateLimit: 60 })
    expect(await revokeApiKey(a, key.id)).toBe(true)
    expect(await verifyApiKey(b, key.key)).toBeNull()

    await recordHealth(a, tag, { ok: true, status: 200, class: 'ok', ms: 1 })
    expect((await latestHealth(b))[tag]?.ok).toBe(true)

    let calls = 0
    const job = async () => ++calls
    const [r1, r2] = await Promise.all([runJobIfDue(a, tag, 60_000, job), runJobIfDue(b, tag, 60_000, job)])
    expect([r1.ran, r2.ran].filter(Boolean)).toHaveLength(1)
    expect(calls).toBe(1)
  })
})
