// AniList GraphQL client: single-media lookups, search, and a small daily sync. Never pages through the whole
// database (AniList's terms forbid mass collection). Disk cache + a daily request cap + their rate-limit headers.
import { join } from 'node:path'
import type { CatalogEntry, CatalogStore } from '../catalog/types.ts'
import { DiskCache } from '../data.ts'
import type { Fetcher } from '../fetch/index.ts'

export const ANILIST_URL = 'https://graphql.anilist.co'
/** For the fetcher config: AniList allows 30 requests/minute right now (normally 90). */
export const ANILIST_HOST_RULE = { match: 'graphql.anilist.co', rateLimit: { requests: 1, perMs: 2_000 }, concurrency: 1 }

export interface AniListTitle {
  romaji: string | null
  english: string | null
  native: string | null
}

export interface AniListRelation {
  relationType: string // PREQUEL | SEQUEL | PARENT | SIDE_STORY | …
  node: {
    id: number
    type: string // ANIME | MANGA
    format: string | null
    episodes: number | null
    status: string | null
    seasonYear: number | null
    title: AniListTitle
  }
}

export interface AniListMedia {
  id: number
  idMal: number | null
  title: AniListTitle
  synonyms: string[]
  format: string | null // TV | TV_SHORT | MOVIE | SPECIAL | OVA | ONA | MUSIC
  episodes: number | null
  status: string | null // FINISHED | RELEASING | NOT_YET_RELEASED | CANCELLED | HIATUS
  season: string | null
  seasonYear: number | null
  startDate: { year: number | null; month: number | null; day: number | null }
  endDate: { year: number | null; month: number | null; day: number | null }
  duration: number | null
  coverImage?: { large: string | null } | null
  nextAiringEpisode: { episode: number; airingAt: number } | null
  relations?: { edges: AniListRelation[] }
}

const TITLE = 'title { romaji english native }'
const BASE = `id idMal ${TITLE} synonyms format episodes status season seasonYear
  startDate { year month day } endDate { year month day } duration coverImage { large }
  nextAiringEpisode { episode airingAt }`
const FULL = `${BASE} relations { edges { relationType node { id type format episodes status seasonYear ${TITLE} } } }`

const Q_MEDIA = `query ($id: Int) { Media(id: $id, type: ANIME) { ${FULL} } }`
const Q_SEARCH = `query ($q: String, $perPage: Int) { Page(perPage: $perPage) {
  media(search: $q, type: ANIME, sort: SEARCH_MATCH) { ${BASE} } } }`
const Q_PAGE = `query ($page: Int, $perPage: Int, $status: MediaStatus, $season: MediaSeason, $seasonYear: Int,
  $sort: [MediaSort]) { Page(page: $page, perPage: $perPage) { pageInfo { hasNextPage }
  media(type: ANIME, status: $status, season: $season, seasonYear: $seasonYear, sort: $sort) { ${BASE} } } }`

export class AniListCapError extends Error {
  override name = 'AniListCapError'
}

export class AniListError extends Error {
  override name = 'AniListError'
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Where AniList answers + the daily usage counter are kept: DiskCache (CLI) or a Postgres table (API). */
export type AniListCache = Pick<DiskCache, 'get' | 'set'>

export interface AniListOptions {
  fetcher: Fetcher
  /** Default: a DiskCache in `<dir>/cache/anilist`. */
  cache?: AniListCache
  /** The data dir, when no cache is given. */
  dir?: string
  /** Requests per UTC day, cache hits excluded. Default 300 (env RECONSUMET_ANILIST_DAILY_CAP). */
  dailyCap?: number
  /** Override the clock (tests). */
  now?: () => Date
  /** Wait implementation (tests). */
  sleep?: (ms: number) => Promise<void>
}

const HOUR = 3_600_000

export function createAniList(opts: AniListOptions) {
  const { fetcher } = opts
  const cap = opts.dailyCap ?? Number(process.env.RECONSUMET_ANILIST_DAILY_CAP || 300)
  const now = opts.now ?? (() => new Date())
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const cache = opts.cache ?? new DiskCache(join(opts.dir ?? '.', 'cache', 'anilist'))
  let pauseUntil = 0

  async function usage() {
    const day = now().toISOString().slice(0, 10)
    return { day, count: (await cache.get<number>(`usage:${day}`)) ?? 0, cap }
  }

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const u = await usage()
    if (u.count >= cap) throw new AniListCapError(`AniList daily cap reached (${u.count}/${cap} on ${u.day})`)
    await cache.set(`usage:${u.day}`, u.count + 1, 2 * 24 * HOUR)
    const wait = pauseUntil - Date.now()
    if (wait > 0) await sleep(wait)

    const res = await fetcher.request(ANILIST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      retry: { methods: ['POST'], maxMs: 65_000 }, // reads are idempotent; honours Retry-After on 429
    })
    // X-RateLimit-Remaining hits 0 → wait for X-RateLimit-Reset (epoch seconds) before the next call
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? Number.NaN)
    if (remaining <= 1) {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000
      pauseUntil = reset > Date.now() ? reset : Date.now() + 60_000
    }
    const json = await res.body.json<{ data?: T; errors?: { message: string; status?: number }[] }>()
    if (json.errors?.length) {
      throw new AniListError(json.errors.map((e) => e.message).join('; '), json.errors[0]?.status ?? res.status)
    }
    if (!json.data) throw new AniListError(`empty response (HTTP ${res.status})`, res.status)
    return json.data
  }

  return {
    usage,

    /** Full details incl. relations. Cached 24 h when finished, 1 h otherwise. null = no such anime. */
    async media(id: number): Promise<AniListMedia | null> {
      const key = `media:${id}`
      const hit = await cache.get<AniListMedia | null>(key)
      if (hit !== undefined) return hit
      let m: AniListMedia | null
      try {
        m = (await gql<{ Media: AniListMedia }>(Q_MEDIA, { id })).Media
      } catch (e) {
        if (!(e instanceof AniListError && e.status === 404)) throw e
        m = null
      }
      await cache.set(key, m, m?.status === 'FINISHED' ? 24 * HOUR : HOUR)
      return m
    },

    async search(q: string, perPage = 10): Promise<AniListMedia[]> {
      const key = `search:${perPage}:${q.toLowerCase()}`
      const hit = await cache.get<AniListMedia[]>(key)
      if (hit) return hit
      const media = (await gql<{ Page: { media: AniListMedia[] } }>(Q_SEARCH, { q, perPage })).Page.media
      await cache.set(key, media, 6 * HOUR)
      return media
    },

    /**
     * The small daily sync: currently airing + next season's upcoming + recently updated, a few pages of ≤50,
     * merged into the catalog so this season's shows exist although the offline database is months old.
     */
    async sync(store: CatalogStore, pages = { airing: 2, upcoming: 1, updated: 1 }) {
      const next = nextSeason(now())
      const plans: [string, number, Record<string, unknown>][] = [
        ['airing', pages.airing, { status: 'RELEASING', sort: ['POPULARITY_DESC'] }],
        ['upcoming', pages.upcoming, { season: next.season, seasonYear: next.year, sort: ['POPULARITY_DESC'] }],
        ['updated', pages.updated, { sort: ['UPDATED_AT_DESC'] }],
      ]
      const counts: Record<string, number> = {}
      const all: AniListMedia[] = []
      for (const [name, n, vars] of plans) {
        counts[name] = 0
        for (let page = 1; page <= n; page++) {
          const r = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; media: AniListMedia[] } }>(Q_PAGE, {
            ...vars,
            page,
            perPage: 50,
          })
          all.push(...r.Page.media)
          counts[name] += r.Page.media.length
          if (!r.Page.pageInfo.hasNextPage) break
        }
      }
      await store.upsert(all.map(toCatalogEntry))
      return { counts, merged: all.length, next }
    },
  }
}

export type AniList = ReturnType<typeof createAniList>

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const

export function nextSeason(d: Date): { season: string; year: number } {
  const i = Math.floor(d.getUTCMonth() / 3) + 1
  return { season: SEASONS[i % 4] as string, year: d.getUTCFullYear() + (i === 4 ? 1 : 0) }
}

const TYPE: Record<string, string> = { TV_SHORT: 'TV', MUSIC: 'SPECIAL' }
const STATUS: Record<string, string> = {
  RELEASING: 'ONGOING',
  HIATUS: 'ONGOING',
  NOT_YET_RELEASED: 'UPCOMING',
  CANCELLED: 'FINISHED',
}

export function toCatalogEntry(m: AniListMedia): CatalogEntry {
  const title = m.title.romaji ?? m.title.english ?? m.title.native ?? String(m.id)
  return {
    anilistId: m.id,
    malId: m.idMal ?? undefined,
    title,
    synonyms: [m.title.english, m.title.native, ...m.synonyms].filter((s): s is string => !!s && s !== title),
    type: m.format ? (TYPE[m.format] ?? m.format) : 'UNKNOWN',
    episodes: m.episodes ?? 0,
    status: m.status ? (STATUS[m.status] ?? m.status) : 'UNKNOWN',
    season: m.season,
    year: m.seasonYear ?? m.startDate.year,
    picture: m.coverImage?.large ?? null,
    duration: m.duration ? m.duration * 60 : null,
  }
}
