import { createHash, randomBytes } from 'node:crypto'
import type { Health } from '@reconsumet/core'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Db } from './db.ts'
import { apiKeys, jobRuns, sourceHealth } from './schema.ts'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** The plaintext key is returned once; only its sha256 is stored. */
export async function createApiKey(db: Db, name: string, rateLimit: number | null = null) {
  const key = `rk_${randomBytes(32).toString('base64url')}`
  const [row] = await db.orm
    .insert(apiKeys)
    .values({ name, keyHash: sha256(key), rateLimit })
    .returning({ id: apiKeys.id })
  return { id: row!.id, key }
}

/** null if unknown or revoked. */
export async function verifyApiKey(db: Db, key: string) {
  const [row] = await db.orm
    .select({ id: apiKeys.id, name: apiKeys.name, rateLimit: apiKeys.rateLimit })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, sha256(key)), isNull(apiKeys.revokedAt)))
  if (!row) return null
  // fire-and-forget: a lost last_used_at bump isn't worth slowing the request
  db.orm
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .then(undefined, () => {})
  return row
}

export async function listApiKeys(db: Db) {
  const rows = await db.orm.select().from(apiKeys).orderBy(apiKeys.id)
  return rows.map(({ id, name, rateLimit, createdAt, lastUsedAt, revokedAt }) => ({
    id,
    name,
    rateLimit,
    createdAt,
    lastUsedAt,
    revoked: revokedAt != null,
  }))
}

export async function revokeApiKey(db: Db, id: number) {
  const rows = await db.orm
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id })
  return rows.length > 0
}

export async function recordHealth(db: Db, sourceId: string, h: Health) {
  await db.orm.insert(sourceHealth).values({
    sourceId,
    ok: h.ok,
    status: h.status,
    class: h.class,
    ms: Math.round(h.ms),
    error: h.error ?? null,
  })
}

/** The newest check per source. */
export async function latestHealth(db: Db) {
  const rows = await db.orm
    .selectDistinctOn([sourceHealth.sourceId])
    .from(sourceHealth)
    .orderBy(sourceHealth.sourceId, desc(sourceHealth.checkedAt), desc(sourceHealth.id))
  const out: Record<string, Health & { checkedAt: Date }> = {}
  for (const r of rows) {
    out[r.sourceId] = {
      ok: r.ok,
      status: r.status,
      class: r.class as Health['class'],
      ms: r.ms,
      ...(r.error != null ? { error: r.error } : {}),
      checkedAt: r.checkedAt,
    }
  }
  return out
}

/**
 * Runs fn if the last successful run of `name` started more than everyMs ago (or never), under a lock so only one
 * process runs it. A failure is recorded and returned, never thrown, and doesn't count as a run: it retries next tick.
 */
export async function runJobIfDue<T>(
  db: Db,
  name: string,
  everyMs: number,
  fn: () => Promise<T>,
): Promise<{ ran: boolean; result?: T; error?: string }> {
  const due = async () => {
    const [last] = await db.orm
      .select({ startedAt: jobRuns.startedAt })
      .from(jobRuns)
      .where(and(eq(jobRuns.name, name), eq(jobRuns.ok, true)))
      .orderBy(desc(jobRuns.startedAt))
      .limit(1)
    return !last || Date.now() - last.startedAt.getTime() >= everyMs
  }
  if (!(await due())) return { ran: false }
  const out = await db.withLock(`job:${name}`, async () => {
    if (!(await due())) return { ran: false } // another process ran it while we waited for the lock
    const [run] = await db.orm.insert(jobRuns).values({ name, startedAt: new Date() }).returning({ id: jobRuns.id })
    const finish = (r: Partial<typeof jobRuns.$inferInsert>) =>
      db.orm
        .update(jobRuns)
        .set({ finishedAt: new Date(), ...r })
        .where(eq(jobRuns.id, run!.id))
    try {
      const result = await fn()
      await finish({ ok: true, result: result ?? null })
      return { ran: true, result }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await finish({ ok: false, error })
      return { ran: true, error }
    }
  })
  return out ?? { ran: false }
}

/** The newest run per job name. */
export async function lastJobRuns(db: Db) {
  return db.orm
    .selectDistinctOn([jobRuns.name], {
      name: jobRuns.name,
      startedAt: jobRuns.startedAt,
      finishedAt: jobRuns.finishedAt,
      ok: jobRuns.ok,
      error: jobRuns.error,
    })
    .from(jobRuns)
    .orderBy(jobRuns.name, desc(jobRuns.startedAt), desc(jobRuns.id))
}
