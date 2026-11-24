/** One anime. Statuses/types use the offline database's vocabulary; AniList values are mapped onto it. */
export interface CatalogEntry {
  anilistId?: number
  malId?: number
  kitsuId?: number
  anidbId?: number
  title: string
  synonyms: string[]
  /** TV | MOVIE | OVA | ONA | SPECIAL | UNKNOWN */
  type: string
  /** 0 = unknown */
  episodes: number
  /** FINISHED | ONGOING | UPCOMING | UNKNOWN */
  status: string
  /** SPRING | SUMMER | FALL | WINTER | null */
  season: string | null
  year: number | null
  picture: string | null
  /** Seconds per episode. */
  duration: number | null
  /** Adult (hentai) title: AniList's isAdult, or the offline database's "hentai" tag. Absent = unknown. */
  isAdult?: boolean
}

export type CatalogRef = Pick<CatalogEntry, 'anilistId' | 'malId' | 'kitsuId' | 'anidbId'>

/**
 * Where the catalog lives. File-backed in 0.3 (FileCatalogStore); Postgres in 0.4 — every method maps to one query
 * (lookup by an ID column, a trigram/ILIKE title search, an upsert, `WHERE status = 'ONGOING'`, a key/value table).
 */
export interface CatalogStore {
  /** Look up by any one ID (the first one set wins: anilist, mal, kitsu, anidb). */
  get(ref: CatalogRef): Promise<CatalogEntry | undefined>
  /** Title + synonym search, normalized (case, accents, punctuation), best first. */
  search(query: string, limit?: number): Promise<CatalogEntry[]>
  /** Insert or merge by any shared ID; incoming values win, synonyms are unioned. */
  upsert(entries: CatalogEntry[]): Promise<void>
  listAiring(): Promise<CatalogEntry[]>
  count(): Promise<number>
  getMeta<T>(key: string): Promise<T | undefined>
  setMeta(key: string, value: unknown): Promise<void>
}
