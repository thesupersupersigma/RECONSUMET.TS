// AniList GraphQL client: single-media lookups, search, and a small daily sync. Never pages through the whole
// database (AniList's terms forbid mass collection). Disk cache, two request budgets (on-demand per minute + per day; the sync its own) + their rate-limit headers.
import { join } from 'node:path'
import type { CatalogEntry, CatalogStore } from '../catalog/types.ts'
import { DiskCache } from '../data.ts'
import type { Fetcher } from '../fetch/index.ts'

export const ANILIST_URL = 'https://graphql.anilist.co'
/** For the fetcher config: AniList allows 30 requests/minute right now (normally 90). */
export const ANILIST_HOST_RULE = {
  match: 'graphql.anilist.co',
  rateLimit: { requests: 1, perMs: 2_000 },
  concurrency: 1,
}

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
  isAdult?: boolean
  coverImage?: { large: string | null } | null
  nextAiringEpisode: { episode: number; airingAt: number } | null
  relations?: { edges: AniListRelation[] }
}

export interface AniListPerson {
  id: number
  name: string | null
  nameNative: string | null
  image: string | null
}

/** What media() returns: AniListMedia plus the anime/watch page fields (0.6). */
export interface AniListDetails extends AniListMedia {
  /** AniList's HTML, unsanitized. */
  description: string | null
  bannerImage: string | null
  coverImage: { extraLarge: string | null; large: string | null; medium: string | null; color: string | null }
  genres: string[]
  tags: { name: string; rank: number | null; isSpoiler: boolean; isAdult: boolean }[]
  averageScore: number | null
  meanScore: number | null
  popularity: number | null
  favourites: number | null
  /** Main studios first. */
  studios: { id: number; name: string; isAnimationStudio: boolean; isMain: boolean }[]
  source: string | null
  countryOfOrigin: string | null
  isAdult: boolean
  hashtag: string | null
  siteUrl: string | null
  trailer: { site: string | null; id: string | null; thumbnail: string | null } | null
  /** First 12, MAIN first; one Japanese + one English voice actor each. */
  characters: (AniListPerson & {
    role: string
    voiceActor: AniListPerson | null
    voiceActorEnglish: AniListPerson | null
  })[]
  /** First 12 by rating. */
  recommendations: {
    id: number
    title: AniListTitle
    format: string | null
    episodes: number | null
    averageScore: number | null
    coverImage: { large: string | null } | null
  }[]
  externalLinks: { site: string; url: string | null; type: string | null; language: string | null }[]
  streamingEpisodes: { title: string | null; thumbnail: string | null; url: string | null; site: string | null }[]
  relations: {
    edges: (AniListRelation & {
      node: AniListRelation['node'] & { coverImage: { large: string | null } | null; averageScore: number | null }
    })[]
  }
}

const TITLE = 'title { romaji english native }'
const BASE = `id idMal ${TITLE} synonyms format episodes status season seasonYear
  startDate { year month day } endDate { year month day } duration isAdult coverImage { large }
  nextAiringEpisode { episode airingAt }`
const PERSON = 'id name { full native } image { large }'
// One request per anime: measured well under AniList's complexity limit (One Piece ≈ 80 KB raw, 2026-11-24).
const DETAILS = `id idMal ${TITLE} synonyms format episodes status season seasonYear
  startDate { year month day } endDate { year month day } duration nextAiringEpisode { episode airingAt }
  coverImage { extraLarge large medium color } bannerImage description genres
  tags { name rank isSpoiler: isMediaSpoiler isAdult } averageScore meanScore popularity favourites source
  countryOfOrigin isAdult hashtag siteUrl trailer { site id thumbnail }
  studios { edges { isMain node { id name isAnimationStudio } } }
  externalLinks { site url type language } streamingEpisodes { title thumbnail url site }
  relations { edges { relationType node { id type format episodes status seasonYear ${TITLE} coverImage { large }
    averageScore } } }
  characters(sort: [ROLE, RELEVANCE, ID], perPage: 12) { edges { role node { ${PERSON} }
    ja: voiceActors(language: JAPANESE, sort: [RELEVANCE, ID]) { ${PERSON} }
    en: voiceActors(language: ENGLISH, sort: [RELEVANCE, ID]) { ${PERSON} } } }
  recommendations(sort: [RATING_DESC, ID], perPage: 12) { nodes { mediaRecommendation { id ${TITLE} format
    episodes averageScore coverImage { large } } } }`

const Q_MEDIA = `query ($id: Int) { Media(id: $id, type: ANIME) { ${DETAILS} } }`
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
  /** On-demand requests (details, search) per UTC day, cache hits excluded. Default 3000 (RECONSUMET_ANILIST_DAILY_CAP). */
  dailyCap?: number
  /** On-demand requests per minute. Default 20 (RECONSUMET_ANILIST_PER_MIN), under AniList's 30/min. */
  perMinute?: number
  /** Override the clock (tests). */
  now?: () => Date
  /** Wait implementation (tests). */
  sleep?: (ms: number) => Promise<void>
}

const MIN = 60_000
const HOUR = 60 * MIN
/** The daily sync's own budget: it needs ~4 requests, so a runaway loop can't eat the on-demand one. */
export const ANILIST_SYNC_DAILY_CAP = 20
/** How long an expired details answer is kept to serve when AniList (or our budget) says no. */
const KEEP_STALE = 30 * 24 * HOUR

type Budget = 'demand' | 'sync'

export function createAniList(opts: AniListOptions) {
  const { fetcher } = opts
  const cap = opts.dailyCap ?? Number(process.env.RECONSUMET_ANILIST_DAILY_CAP || 3000)
  const perMinute = opts.perMinute ?? Number(process.env.RECONSUMET_ANILIST_PER_MIN || 20)
  const now = opts.now ?? (() => new Date())
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const cache = opts.cache ?? new DiskCache(join(opts.dir ?? '.', 'cache', 'anilist'))
  let pauseUntil = 0
  // shortcut: per-minute window is per process; fine for one API instance, move to the cache table for several.
  let recent: number[] = []
  const inflight = new Map<number, Promise<AniListDetails | null>>()

  async function usage() {
    const t = now().getTime()
    const day = now().toISOString().slice(0, 10)
    recent = recent.filter((r) => r > t - MIN)
    return {
      day,
      count: (await cache.get<number>(`usage:${day}`)) ?? 0,
      cap,
      lastMinute: recent.length,
      perMinute,
      sync: { count: (await cache.get<number>(`sync:${day}`)) ?? 0, cap: ANILIST_SYNC_DAILY_CAP },
      pausedUntil: pauseUntil > t ? new Date(pauseUntil).toISOString() : null,
    }
  }

  async function gql<T>(query: string, variables: Record<string, unknown>, budget: Budget = 'demand'): Promise<T> {
    const u = await usage()
    if (budget === 'sync') {
      if (u.sync.count >= u.sync.cap)
        throw new AniListCapError(`AniList sync cap reached (${u.sync.count} on ${u.day})`)
      await cache.set(`sync:${u.day}`, u.sync.count + 1, 2 * 24 * HOUR)
      const wait = pauseUntil - now().getTime()
      if (wait > 0) await sleep(wait) // the sync can wait; a page view can't
    } else {
      if (u.pausedUntil) throw new AniListCapError(`AniList asked us to slow down until ${u.pausedUntil}`)
      if (u.lastMinute >= perMinute) throw new AniListCapError(`AniList per-minute budget used (${perMinute}/min)`)
      if (u.count >= cap) throw new AniListCapError(`AniList daily cap reached (${u.count}/${cap} on ${u.day})`)
      recent.push(now().getTime())
      await cache.set(`usage:${u.day}`, u.count + 1, 2 * 24 * HOUR)
    }

    const res = await fetcher.request(ANILIST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      // reads are idempotent; honours Retry-After on 429, but a page view only waits a few seconds
      retry: { methods: ['POST'], maxMs: budget === 'sync' ? 65_000 : 5_000 },
    })
    // X-RateLimit-Remaining hits 0 or a 429 → everyone backs off until X-RateLimit-Reset / Retry-After
    const t = now().getTime()
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? Number.NaN)
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'))
      pauseUntil = t + (after > 0 ? after * 1000 : MIN)
    } else if (remaining <= 1) {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000
      pauseUntil = reset > t ? reset : t + MIN
    }
    const json = await res.body.json<{ data?: T; errors?: { message: string; status?: number }[] }>()
    if (json.errors?.length) {
      throw new AniListError(json.errors.map((e) => e.message).join('; '), json.errors[0]?.status ?? res.status)
    }
    if (!json.data) throw new AniListError(`empty response (HTTP ${res.status})`, res.status)
    return json.data
  }

  type Cached = { m: AniListDetails | null; fresh: number }

  async function fetchDetails(id: number, stale: Cached | undefined): Promise<AniListDetails | null> {
    let m: AniListDetails | null
    try {
      m = toDetails((await gql<{ Media: RawDetails }>(Q_MEDIA, { id })).Media)
    } catch (e) {
      if (e instanceof AniListError && e.status === 404) m = null
      else if (stale)
        return stale.m // stale beats error: cap, 429, AniList down
      else throw e
    }
    const ttl = m?.status === 'FINISHED' ? 24 * HOUR : HOUR
    await cache.set(`details:${id}`, { m, fresh: now().getTime() + ttl } satisfies Cached, KEEP_STALE)
    return m
  }

  return {
    usage,

    /**
     * Full details (anime + watch page). Fresh for 24 h when finished, 1 h otherwise; after that the old answer is
     * still served if AniList or the budget says no. Concurrent calls for one ID share one request. null = no such anime.
     */
    async media(id: number): Promise<AniListDetails | null> {
      const hit = await cache.get<Cached>(`details:${id}`)
      if (hit && hit.fresh > now().getTime()) return hit.m
      let p = inflight.get(id)
      if (!p) {
        p = fetchDetails(id, hit).finally(() => inflight.delete(id))
        inflight.set(id, p)
      }
      return p
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
          const r = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; media: AniListMedia[] } }>(
            Q_PAGE,
            {
              ...vars,
              page,
              perPage: 50,
            },
            'sync',
          )
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
    ...(m.isAdult === undefined ? {} : { isAdult: m.isAdult }),
  }
}

type RawPerson = {
  id: number
  name: { full: string | null; native: string | null }
  image: { large: string | null } | null
}
type RawDetails = Omit<AniListDetails, 'studios' | 'characters' | 'recommendations'> & {
  studios: { edges: { isMain: boolean; node: { id: number; name: string; isAnimationStudio: boolean } }[] }
  characters: { edges: { role: string; node: RawPerson; ja: RawPerson[]; en: RawPerson[] }[] }
  recommendations: { nodes: { mediaRecommendation: AniListDetails['recommendations'][number] | null }[] }
}

const person = (p: RawPerson | undefined): AniListPerson | null =>
  p ? { id: p.id, name: p.name.full, nameNative: p.name.native, image: p.image?.large ?? null } : null

/** AniList's nested studios / characters / recommendations → the flat lists the API serves. */
export function toDetails(r: RawDetails): AniListDetails {
  return {
    ...r,
    studios: r.studios.edges
      .map((e) => ({ ...e.node, isMain: e.isMain }))
      .sort((a, b) => Number(b.isMain) - Number(a.isMain)),
    characters: r.characters.edges.map((e) => ({
      ...(person(e.node) as AniListPerson),
      role: e.role,
      voiceActor: person(e.ja[0]),
      voiceActorEnglish: person(e.en[0]),
    })),
    recommendations: r.recommendations.nodes.flatMap((n) => n.mediaRecommendation ?? []),
  }
}

/**
 * Episode number → title + thumbnail from AniList's streamingEpisodes ("Episode 5 - Title"). Numbers that appear
 * twice with different titles are dropped (ambiguous); entries without a number are ignored.
 */
export function streamingEpisodeExtras(
  eps: AniListDetails['streamingEpisodes'],
): Map<number, { title?: string; thumbnail?: string }> {
  const out = new Map<number, { title?: string; thumbnail?: string }>()
  const bad = new Set<number>()
  for (const e of eps) {
    const m = e.title?.match(/^Episode\s+(\d+(?:\.\d+)?)\s*(?:[-–:]\s*(.+))?$/i)
    if (!m) continue
    const n = Number(m[1])
    const v = { ...(m[2] ? { title: m[2].trim() } : {}), ...(e.thumbnail ? { thumbnail: e.thumbnail } : {}) }
    const old = out.get(n)
    if (old && old.title !== v.title) bad.add(n)
    out.set(n, v)
  }
  for (const n of bad) out.delete(n)
  return out
}
