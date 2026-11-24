import type { MatchResult } from '@reconsumet/core'
import { describe, expect, it } from 'vitest'
import {
  connectPglite,
  createApiKey,
  lastJobRuns,
  latestHealth,
  listApiKeys,
  migrate,
  pgCache,
  pgMappingStore,
  pruneCache,
  recordHealth,
  revokeApiKey,
  runJobIfDue,
  schema,
  verifyApiKey,
} from '../src/index.ts'
import { freshDb } from './helpers.ts'

describe('migrate', () => {
  it('is idempotent and waits for a concurrent run', async () => {
    const db = await connectPglite()
    try {
      await Promise.all([migrate(db), migrate(db)])
      await migrate(db)
      expect(await db.orm.$count(schema.catalog)).toBe(0)
    } finally {
      await db.close()
    }
  })
})

describe('pgMappingStore', () => {
  const result: MatchResult = {
    sourceId: 'reanime',
    anilistId: 1,
    showId: 'frieren-1',
    title: 'Frieren',
    confidence: 0.93,
    episodeOffset: 0,
    episodeRange: [1, 28],
    reasons: ['title'],
  }

  it('stores mappings and overrides', async () => {
    const store = pgMappingStore(await freshDb())
    expect(await store.get('reanime', 1)).toBeUndefined()
    await store.set(result)
    await store.set({ ...result, showId: null, confidence: 0, episodeRange: undefined, title: undefined })
    const hit = await store.get('reanime', 1)
    expect(hit?.result).toEqual({
      sourceId: 'reanime',
      anilistId: 1,
      showId: null,
      confidence: 0,
      episodeOffset: 0,
      reasons: ['title'],
    })
    expect(Date.now() - (hit?.at ?? 0)).toBeLessThan(10_000)
    await store.set(result)
    expect((await store.get('reanime', 1))?.result).toEqual(result)

    expect(await store.override('reanime', 1)).toBeUndefined()
    await store.setOverride('reanime', 1, { showId: null })
    expect(await store.override('reanime', 1)).toEqual({ showId: null })
    await store.setOverride('reanime', 1, { showId: 'x', episodeOffset: 12, episodeRange: [13, 24], note: 'part 2' })
    expect(await store.override('reanime', 1)).toEqual({
      showId: 'x',
      episodeOffset: 12,
      episodeRange: [13, 24],
      note: 'part 2',
    })
    expect(await store.override('other', 1)).toBeUndefined()
    await store.deleteOverride('reanime', 1)
    expect(await store.override('reanime', 1)).toBeUndefined()
    expect(await store.get('reanime', 1)).toBeDefined() // the mapping stays
  })
})

describe('pgCache', () => {
  it('expires, keeps null values, isolates namespaces, prunes', async () => {
    const db = await freshDb()
    const anilist = pgCache(db, 'anilist')
    const streams = pgCache(db, 'streams')
    await anilist.set('media:1', { id: 1 }, 60_000)
    await anilist.set('media:2', null, 60_000)
    await anilist.set('old', 'x', -1)
    await streams.set('old', 'y', -1)
    expect(await anilist.get('media:1')).toEqual({ id: 1 })
    expect(await anilist.get('media:2')).toBeNull()
    expect(await anilist.get('missing')).toBeUndefined()
    expect(await anilist.get('old')).toBeUndefined()
    expect(await streams.get('media:1')).toBeUndefined()
    await streams.set('media:1', 5, 60_000)
    expect(await streams.get('media:1')).toBe(5)
    expect(await anilist.get('media:1')).toEqual({ id: 1 })
    await anilist.set('old', 'fresh', 60_000) // overwrite revives
    expect(await anilist.get('old')).toBe('fresh')
    expect(await pruneCache(db)).toBe(1)
    expect(await pruneCache(db)).toBe(0)
  })
})

describe('api keys', () => {
  it('creates, verifies, lists and revokes; stores only the hash', async () => {
    const db = await freshDb()
    const a = await createApiKey(db, 'site')
    const b = await createApiKey(db, 'bot', 600)
    expect(a.key).toMatch(/^rk_[\w-]{43}$/)
    expect(JSON.stringify(await db.orm.select().from(schema.apiKeys))).not.toContain(a.key)
    expect(await verifyApiKey(db, a.key)).toEqual({ id: a.id, name: 'site', rateLimit: null })
    expect(await verifyApiKey(db, b.key)).toEqual({ id: b.id, name: 'bot', rateLimit: 600 })
    expect(await verifyApiKey(db, 'rk_nope')).toBeNull()

    expect(await revokeApiKey(db, a.id)).toBe(true)
    expect(await revokeApiKey(db, a.id)).toBe(false)
    expect(await revokeApiKey(db, 999)).toBe(false)
    expect(await verifyApiKey(db, a.key)).toBeNull()
    const list = await listApiKeys(db)
    expect(list.map((k) => [k.name, k.revoked])).toEqual([
      ['site', true],
      ['bot', false],
    ])
    expect(list[1]?.lastUsedAt).toBeInstanceOf(Date)
  })
})

describe('source health', () => {
  it('returns the newest check per source', async () => {
    const db = await freshDb()
    await recordHealth(db, 'a', { ok: false, status: 503, class: 'cf-block', ms: 10.4, error: 'down' })
    await recordHealth(db, 'a', { ok: true, status: 200, class: 'ok', ms: 120 })
    await recordHealth(db, 'b', { ok: false, status: null, class: 'error', ms: 5, error: 'timeout' })
    const latest = await latestHealth(db)
    expect(latest.a).toMatchObject({ ok: true, status: 200, ms: 120 })
    expect(latest.a?.error).toBeUndefined()
    expect(latest.b).toMatchObject({ ok: false, status: null, class: 'error', error: 'timeout' })
    expect(latest.b?.checkedAt).toBeInstanceOf(Date)
  })
})

describe('runJobIfDue', () => {
  it('runs when due, retries failures, skips while locked', async () => {
    const db = await freshDb()
    let calls = 0
    const job = async () => ++calls

    expect(await runJobIfDue(db, 'sync', 60_000, job)).toEqual({ ran: true, result: 1 })
    expect(await runJobIfDue(db, 'sync', 60_000, job)).toEqual({ ran: false })
    expect(await runJobIfDue(db, 'sync', 0, job)).toEqual({ ran: true, result: 2 })

    const boom = async () => {
      throw new Error('boom')
    }
    expect(await runJobIfDue(db, 'flaky', 60_000, boom)).toEqual({ ran: true, error: 'boom' })
    expect(await runJobIfDue(db, 'flaky', 60_000, job)).toEqual({ ran: true, result: 3 }) // failure isn't a run

    // another runner holds the lock
    const held = await db.withLock('job:locked', () => runJobIfDue(db, 'locked', 60_000, job))
    expect(held).toEqual({ ran: false })
    expect(calls).toBe(3)

    const runs = await lastJobRuns(db)
    expect(runs.map((r) => [r.name, r.ok, r.error])).toEqual([
      ['flaky', true, null],
      ['sync', true, null],
    ])
    expect(runs[0]?.finishedAt).toBeInstanceOf(Date)
  })
})
