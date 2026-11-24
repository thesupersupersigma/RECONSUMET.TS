import type { AniListCache, MappingStore, MatchResult, Override } from '@reconsumet/core'
import { and, eq, gt, lt } from 'drizzle-orm'
import type { Db } from './db.ts'
import { cache, mappings, overrides } from './schema.ts'

const range = (r: number[] | null) => (r?.length === 2 ? { episodeRange: r as [number, number] } : {})

/** Mapping cache + manual overrides (the Postgres twin of core's fileMappingStore). */
export function pgMappingStore(db: Db): MappingStore & {
  setOverride(sourceId: string, anilistId: number, o: Override): Promise<void>
  deleteOverride(sourceId: string, anilistId: number): Promise<void>
} {
  const key = <T extends typeof mappings | typeof overrides>(t: T, sourceId: string, anilistId: number) =>
    and(eq(t.sourceId, sourceId), eq(t.anilistId, anilistId))
  return {
    async override(sourceId, anilistId) {
      const [o] = await db.orm
        .select()
        .from(overrides)
        .where(key(overrides, sourceId, anilistId))
      if (!o) return undefined
      return {
        showId: o.showId,
        ...(o.episodeOffset != null ? { episodeOffset: o.episodeOffset } : {}),
        ...range(o.episodeRange),
        ...(o.note != null ? { note: o.note } : {}),
      }
    },
    async get(sourceId, anilistId) {
      const [m] = await db.orm
        .select()
        .from(mappings)
        .where(key(mappings, sourceId, anilistId))
      if (!m) return undefined
      const result: MatchResult = {
        sourceId,
        anilistId,
        showId: m.showId,
        ...(m.title != null ? { title: m.title } : {}),
        confidence: m.confidence,
        episodeOffset: m.episodeOffset,
        ...range(m.episodeRange),
        reasons: m.reasons,
      }
      return { at: m.checkedAt.getTime(), result }
    },
    async set(r) {
      const row = {
        showId: r.showId,
        title: r.title ?? null,
        confidence: r.confidence,
        episodeOffset: r.episodeOffset,
        episodeRange: r.episodeRange ?? null,
        reasons: r.reasons,
        checkedAt: new Date(),
      }
      await db.orm
        .insert(mappings)
        .values({ sourceId: r.sourceId, anilistId: r.anilistId, ...row })
        .onConflictDoUpdate({ target: [mappings.sourceId, mappings.anilistId], set: row })
    },
    async setOverride(sourceId, anilistId, o) {
      const row = {
        showId: o.showId,
        episodeOffset: o.episodeOffset ?? null,
        episodeRange: o.episodeRange ?? null,
        note: o.note ?? null,
        overriddenAt: new Date(),
      }
      await db.orm
        .insert(overrides)
        .values({ sourceId, anilistId, ...row })
        .onConflictDoUpdate({ target: [overrides.sourceId, overrides.anilistId], set: row })
    },
    async deleteOverride(sourceId, anilistId) {
      await db.orm.delete(overrides).where(key(overrides, sourceId, anilistId))
    },
  }
}

/** A TTL'd JSON cache in one namespace of the `cache` table (DiskCache semantics: expired = undefined; null is a value). */
export function pgCache(db: Db, ns: string): AniListCache {
  return {
    async get<T>(key: string) {
      const [row] = await db.orm
        .select({ value: cache.value })
        .from(cache)
        .where(and(eq(cache.ns, ns), eq(cache.key, key), gt(cache.expiresAt, new Date())))
      return row ? (row.value as T) : undefined
    },
    async set(key: string, value: unknown, ttlMs: number) {
      const row = { value, fetchedAt: new Date(), expiresAt: new Date(Date.now() + ttlMs) }
      await db.orm
        .insert(cache)
        .values({ ns, key, ...row })
        .onConflictDoUpdate({ target: [cache.ns, cache.key], set: row })
    },
  }
}

/** Deletes expired cache rows; returns how many. */
export async function pruneCache(db: Db): Promise<number> {
  const gone = await db.orm.delete(cache).where(lt(cache.expiresAt, new Date())).returning({ key: cache.key })
  return gone.length
}
