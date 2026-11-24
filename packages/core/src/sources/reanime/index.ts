// Re:Anime (reanime.cz) — SvelteKit site with a JSON API keyed by AniList IDs. Recon notes: ./README.md
import { extractFlixCloud } from '../../extractors/flixcloud.ts'
import type { Fetcher } from '../../fetch/index.ts'
import { checkHealth } from '../health.ts'
import type { Audio, Episode, SearchResult, Server, Source, SourceDefinition } from '../types.ts'

const BASE = 'https://reanime.cz'
const TYPES: Record<string, string> = { TV_SHORT: 'TV', MUSIC: 'SPECIAL' }

interface ApiSearch {
  results: {
    anime_id: string
    anilist_id: number
    title: { english: string | null; romaji: string | null; native: string | null }
    format: string | null
    season_year: number | null
    episodes: number | null
    subbed: number | null
  }[]
}

interface ApiEpisodes {
  total: number
  data: { episode_number: number; title: string | null; subbed: boolean; dubbed: boolean; playable: boolean }[]
}

interface ApiWatch {
  anime: { title: { english: string | null; romaji: string | null }; cover_image?: Record<string, string | null> }
}

interface ApiServers {
  success: boolean
  servers: { serverName: string; dataLink: string; dataType: Audio }[]
}

export function parseSearch(json: ApiSearch): SearchResult[] {
  return json.results.map((r) => {
    const title = r.title.romaji ?? r.title.english ?? r.anime_id
    return {
      id: `${r.anilist_id}/${r.anime_id}`,
      title,
      altTitles: [r.title.english, r.title.native].filter((t): t is string => !!t && t !== title),
      type: r.format ? (TYPES[r.format] ?? r.format) : undefined,
      year: r.season_year || undefined,
      episodes: r.episodes || r.subbed || undefined,
      anilistId: r.anilist_id,
    }
  })
}

/** The watch payload has no AniList ID field any more; the AniList cover URL carries it (…/bx154587-hash.jpg). */
export function anilistIdFromWatch(json: ApiWatch): number | undefined {
  const url = Object.values(json.anime.cover_image ?? {}).find((u) => u?.includes('anilistcdn'))
  const id = url?.match(/\/[a-z]*(\d+)-[^/]*$/)?.[1]
  return id ? Number(id) : undefined
}

export function parseEpisodes(json: ApiEpisodes, anilistId: number): Episode[] {
  return json.data
    .filter((e) => e.playable !== false)
    .map((e) => ({
      number: e.episode_number,
      title: e.title ?? undefined,
      id: `${anilistId}/${e.episode_number}`,
      sub: e.subbed,
      dub: e.dubbed,
    }))
    .sort((a, b) => a.number - b.number)
}

export function parseServers(json: ApiServers, audio: Audio) {
  return json.servers.filter((s) => s.dataType === audio)
}

export function createReAnime(fetcher: Fetcher): Source {
  const api = async <T>(path: string): Promise<T> => {
    const res = await fetcher.request(`${BASE}${path}`, { headers: { accept: 'application/json' } })
    if (res.status !== 200) {
      await res.body.cancel()
      throw new Error(`reanime: HTTP ${res.status} for ${path}`)
    }
    return res.body.json<T>()
  }

  return {
    id: 'reanime',
    name: 'Re:Anime',
    baseUrl: BASE,

    async search(query) {
      return parseSearch(await api<ApiSearch>(`/api/v1/search?q=${encodeURIComponent(query)}&limit=20`))
    },

    /** id = "<anilistId>/<slug>" (what search returns) or a bare slug (one more request to find the AniList ID). */
    async getShow(id) {
      let [anilistId, slug] = id.includes('/') ? [Number(id.split('/')[0]), id.split('/')[1] as string] : [0, id]
      let title = slug
      if (!anilistId) {
        const watch = await api<ApiWatch>(`/api/v1/watch/${encodeURIComponent(slug)}?ep=1`)
        anilistId = anilistIdFromWatch(watch) ?? 0
        if (!anilistId) throw new Error(`reanime: no AniList ID for ${slug}`)
        title = watch.anime.title.romaji ?? watch.anime.title.english ?? slug
      }
      const eps = await api<ApiEpisodes>(`/api/v1/anime/${encodeURIComponent(slug)}/episodes?limit=2000`)
      return { id: `${anilistId}/${slug}`, title, episodes: parseEpisodes(eps, anilistId), anilistId }
    },

    episodeId: (showId, n) => `${showId.split('/')[0]}/${n}`,

    /** episodeId = "<anilistId>/<episode>" — the flix route is keyed by AniList ID. */
    async getStreams(episodeId, { audio = 'sub' } = {}) {
      const [anilistId, ep] = episodeId.split('/')
      if (!/^\d+$/.test(anilistId ?? '') || !/^\d+(\.\d+)?$/.test(ep ?? '')) {
        throw new Error(`reanime: bad episode id "${episodeId}" (want <anilistId>/<episode>)`)
      }
      const embeds = parseServers(await api<ApiServers>(`/api/flix/${anilistId}/${ep}`), audio)
      // HD-2 first: HD-1's URL is signed for our IP, so it only plays through a relay
      embeds.sort((a, b) => b.serverName.localeCompare(a.serverName))
      const servers: Server[] = []
      const errors: string[] = []
      for (const e of embeds) {
        try {
          const server = await extractFlixCloud(fetcher, e.dataLink, `${BASE}/`)
          for (const s of server.streams) s.audioLang = audio === 'dub' ? 'eng' : 'jpn'
          servers.push({ ...server, name: `${e.serverName} (FlixCloud)` })
        } catch (err) {
          errors.push(`${e.serverName}: ${(err as Error).message}`)
        }
      }
      if (!servers.length) throw new Error(`reanime: no working ${audio} server for ${episodeId}. ${errors.join('; ')}`)
      return { servers }
    },

    health: () => checkHealth(fetcher, `${BASE}/api/v1/search?q=a&limit=1`),
  }
}

export const reanime: SourceDefinition = {
  id: 'reanime',
  name: 'Re:Anime',
  hostRules: [
    { match: 'reanime.cz', rateLimit: { requests: 1, perMs: 1000 }, concurrency: 2 },
    // embed + token API on flixcloud.cc; playlists/segments (fetchN.flixcloud.cc, *.vertexcdn.site, …) are the
    // proxy's business in 0.4 and need FLIXCLOUD_HEADERS
    { match: 'flixcloud.cc', rateLimit: { requests: 1, perMs: 1000 }, concurrency: 2 },
  ],
  create: createReAnime,
}
