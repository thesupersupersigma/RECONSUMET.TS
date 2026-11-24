import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { migrate as runMigrations } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import * as schema from './schema.ts'

export type Orm = PgDatabase<PgQueryResultHKT, typeof schema>

export interface Db {
  orm: Orm
  /** Session-level pg_try_advisory_lock(hashtext(name)); runs fn only if acquired; unlocks after. undefined = someone else holds it. */
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T | undefined>
  close(): Promise<void>
}

/** A postgres.js pool. withLock holds one connection for its duration, so keep max >= 2. */
export function connect(url: string, opts: { max?: number } = {}): Db {
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} }) // "already exists, skipping" noise
  return {
    orm: drizzle({ client, schema }),
    async withLock(name, fn) {
      const conn = await client.reserve()
      try {
        const [row] = await conn`select pg_try_advisory_lock(hashtext(${name})) as ok`
        if (!row?.ok) return undefined
        try {
          return await fn()
        } finally {
          await conn`select pg_advisory_unlock(hashtext(${name}))`
        }
      } finally {
        conn.release()
      }
    },
    close: () => client.end(),
  }
}

/** In-memory PGlite with pg_trgm, for tests and dev. */
export async function connectPglite(): Promise<Db> {
  // dynamic: PGlite is a dev dependency, production only uses connect()
  const [{ PGlite }, { pg_trgm }, { drizzle }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite/contrib/pg_trgm'),
    import('drizzle-orm/pglite'),
  ])
  const client = new PGlite({ extensions: { pg_trgm } })
  // one session, where advisory locks are re-entrant and so exclude nothing: lock in-process instead
  const held = new Set<string>()
  return {
    orm: drizzle({ client, schema }),
    async withLock(name, fn) {
      if (held.has(name)) return undefined
      held.add(name)
      try {
        return await fn()
      } finally {
        held.delete(name)
      }
    },
    close: () => client.close(),
  }
}

/** Applies drizzle/ migrations; waits while another process holds the migration lock. Idempotent. */
export async function migrate(db: Db): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
  // both drivers' migrators are the same code (dialect.migrate on db.session); only their types differ
  const run = () => runMigrations(db.orm as PostgresJsDatabase<typeof schema>, { migrationsFolder }).then(() => true)
  while (!(await db.withLock('reconsumet:migrate', run))) await sleep(500)
}
