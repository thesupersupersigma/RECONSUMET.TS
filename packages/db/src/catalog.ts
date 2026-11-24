import { type CatalogEntry, type CatalogRef, type CatalogStore, normalizeTitle } from '@reconsumet/core'
import { and, eq, inArray, like, or, sql } from 'drizzle-orm'
import type { Db } from './db.ts'
import { catalog, catalogMeta } from './schema.ts'

const ID_KEYS = ['anilistId', 'malId', 'kitsuId', 'anidbId'] as const
const BATCH = 1000

type Row = typeof catalog.$inferSelect

function toEntry(row: Row): CatalogEntry {
  const { title, synonyms, type, episodes, status, season, year, picture, duration } = row
  const e: CatalogEntry = { title, synonyms, type, episodes, status, season, year, picture, duration }
  for (const k of ID_KEYS) if (row[k] != null) e[k] = row[k]
  return e
}

function toRow(e: CatalogEntry) {
  const names = [...new Set([e.title, ...e.synonyms].map(normalizeTitle))]
  return {
    anilistId: e.anilistId ?? null,
    malId: e.malId ?? null,
    kitsuId: e.kitsuId ?? null,
    anidbId: e.anidbId ?? null,
    title: e.title,
    synonyms: e.synonyms,
    type: e.type,
    episodes: e.episodes,
    status: e.status,
    season: e.season,
    year: e.year,
    picture: e.picture,
    duration: e.duration,
    search: names.join(' | '),
  }
}

/** Same as FileCatalogStore: incoming non-empty values win, synonyms are unioned minus the title. */
function merge(old: CatalogEntry, e: CatalogEntry): CatalogEntry {
  const merged: CatalogEntry = { ...old }
  for (const [k, v] of Object.entries(e)) if (v != null && v !== '' && v !== 0) Object.assign(merged, { [k]: v })
  merged.synonyms = [...new Set([...old.synonyms, ...e.synonyms])].filter((s) => s !== merged.title)
  return merged
}

/** The catalog in Postgres, with FileCatalogStore's semantics. */
export class PgCatalogStore implements CatalogStore {
  readonly db: Db
  constructor(db: Db) {
    this.db = db
  }

  async get(ref: CatalogRef) {
    for (const k of ID_KEYS) {
      const id = ref[k]
      if (id == null) continue
      const [row] = await this.db.orm.select().from(catalog).where(eq(catalog[k], id))
      if (row) return toEntry(row)
    }
    return undefined
  }

  /** Exact name > prefix > all words in one name (as FileCatalogStore), then trigram word similarity; newest first. */
  async search(query: string, limit = 20) {
    const q = normalizeTitle(query)
    if (!q) return []
    const words = q.split(' ')
    const allWords = sql.join(
      words.map((w) => sql`${`%${w}%`}`),
      sql`, `,
    )
    const score = sql`(select max(case when n = ${q} then 3 when n like ${`${q}%`} then 2
      when n like all(array[${allWords}]) then 1 else 0 end) from unnest(string_to_array(${catalog.search}, ' | ')) n)`
    const rows = await this.db.orm
      .select()
      .from(catalog)
      .where(or(and(...words.map((w) => like(catalog.search, `%${w}%`))), sql`${q} <% ${catalog.search}`))
      .orderBy(
        sql`coalesce(nullif(${score}, 0), word_similarity(${q}, ${catalog.search})) desc`,
        sql`${catalog.year} desc nulls last`,
      )
      .limit(limit)
    return rows.map(toEntry)
  }

  async upsert(entries: CatalogEntry[]) {
    await this.db.orm.transaction(async (tx) => {
      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH)
        const conds = ID_KEYS.flatMap((k) => {
          const ids = [...new Set(batch.flatMap((e) => e[k] ?? []))]
          return ids.length ? [inArray(catalog[k], ids)] : []
        })
        const existing = conds.length
          ? await tx
              .select()
              .from(catalog)
              .where(or(...conds))
          : []

        // merge in memory, like FileCatalogStore, then replace the touched rows (delete + insert keeping their ids)
        type Rec = { id?: number; entry: CatalogEntry }
        const byId = new Map<string, Rec>()
        const dirty = new Set<Rec>()
        const index = (r: Rec) => {
          for (const k of ID_KEYS) {
            const v = r.entry[k]
            if (v == null) continue
            const other = byId.get(`${k}:${v}`)
            // the merged entry now owns an ID another row has: take it over (the file store's index would point here too)
            if (other && other !== r && other.entry[k] === v) {
              other.entry = { ...other.entry, [k]: undefined }
              dirty.add(other)
            }
            byId.set(`${k}:${v}`, r)
          }
        }
        const find = (e: CatalogEntry) => {
          for (const k of ID_KEYS) {
            const r = e[k] == null ? undefined : byId.get(`${k}:${e[k]}`)
            if (r) return r
          }
          return undefined
        }
        for (const row of existing) index({ id: row.id, entry: toEntry(row) })
        for (const e of batch) {
          let r = find(e)
          if (r) r.entry = merge(r.entry, e)
          else r = { entry: e }
          index(r)
          dirty.add(r)
        }

        const ids = [...dirty].flatMap((r) => r.id ?? [])
        if (ids.length) await tx.delete(catalog).where(inArray(catalog.id, ids))
        await tx.insert(catalog).values([...dirty].map((r) => ({ ...(r.id ? { id: r.id } : {}), ...toRow(r.entry) })))
      }
    })
  }

  async listAiring() {
    return (await this.db.orm.select().from(catalog).where(eq(catalog.status, 'ONGOING'))).map(toEntry)
  }

  count() {
    return this.db.orm.$count(catalog)
  }

  async getMeta<T>(key: string) {
    const [row] = await this.db.orm.select().from(catalogMeta).where(eq(catalogMeta.key, key))
    return row ? (row.value as T) : undefined
  }

  async setMeta(key: string, value: unknown) {
    await this.db.orm.insert(catalogMeta).values({ key, value }).onConflictDoUpdate({
      target: catalogMeta.key,
      set: { value },
    })
  }
}
