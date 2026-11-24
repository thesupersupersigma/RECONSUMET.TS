import type { CatalogEntry } from '@reconsumet/core'
import { afterEach } from 'vitest'
import { connectPglite, type Db, migrate } from '../src/index.ts'

const open: Db[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()))
})

/** A migrated in-memory database, closed after the test. */
export async function freshDb() {
  const db = await connectPglite()
  open.push(db)
  await migrate(db)
  return db
}

export const entry = (e: Partial<CatalogEntry>): CatalogEntry => ({
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
