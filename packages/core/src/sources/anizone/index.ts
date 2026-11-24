// AniZone (anizone.to) — Laravel Livewire + Alpine; every list is a JSON blob in the HTML. Recon notes: ./README.md
import type { Fetcher } from '../../fetch/index.ts'
import { checkHealth } from '../health.ts'
import type { Episode, SearchResult, Server, Source, SourceDefinition, Subtitle } from '../types.ts'

const BASE = 'https://anizone.to'
const MAX_PAGES = 100 // 24 episodes per Livewire page → 2400 episodes
const TYPES: Record<string, string> = {
  'TV Series': 'TV',
  Movie: 'MOVIE',
  OVA: 'OVA',
  Web: 'ONA',
  'TV Special': 'SPECIAL',
  Special: 'SPECIAL',
}

interface ApiAnime {
  slug: string
  main_title: string
  title_list: Record<string, string>
  type: string
  start_year: number | null
  episode_count: number | null
}

interface ApiEpisode {
  slug: string
  title_list: Record<string, string>
  type: string
}

interface ApiPlayer {
  src: string
  subtitles?: { title: string; format: string; language: string; default: boolean; file: string }[]
}

/** `key: JSON.parse('…')` / `fn(JSON.parse('…'))` blobs: a JS string literal (Laravel Js::from) holding JSON. */
function jsonBlob<T>(html: string, prefix: string): T | undefined {
  const m = html.match(new RegExp(`${prefix}\\s*JSON\\.parse\\('((?:[^'\\\\]|\\\\.)*)'\\)`))
  if (!m) return undefined
  return JSON.parse(JSON.parse(`"${(m[1] as string).replace(/\\'/g, "'")}"`)) as T
}

function listState(html: string): { nextCursor: string | null; hasMore: boolean } {
  return {
    nextCursor: html.match(/nextCursor:\s*'([^']+)'/)?.[1] ?? null,
    hasMore: /hasMore:\s*true/.test(html),
  }
}

export function parseSearch(html: string): SearchResult[] {
  const items = jsonBlob<ApiAnime[]>(html, 'items:')
  if (!items) throw new Error('anizone: no result list in the search page (layout changed?)')
  return items.map((a) => ({
    id: a.slug,
    title: a.main_title,
    altTitles: [...new Set(Object.values(a.title_list))].filter((t) => t !== a.main_title),
    type: TYPES[a.type] ?? 'UNKNOWN',
    year: a.start_year ?? undefined,
    episodes: a.episode_count ?? undefined,
  }))
}

export function parseEpisodeItems(slug: string, items: ApiEpisode[]): Episode[] {
  return items
    .filter((e) => /^\d+(\.\d+)?$/.test(e.slug))
    .map((e) => ({
      number: Number(e.slug),
      title: e.title_list['1'] ?? Object.values(e.title_list)[0],
      id: `${slug}/${e.slug}`,
      sub: true,
    }))
}

export function parseShowPage(html: string) {
  const titles = jsonBlob<Record<string, string>>(html, 'anmTitles:') ?? {}
  return {
    title: titles['5'] ?? titles['1'] ?? html.match(/<title>([^<]*?)\s*—\s*AniZone/)?.[1] ?? '',
    items: jsonBlob<ApiEpisode[]>(html, 'items:') ?? [],
    ...listState(html),
  }
}

export function parseEpisodePage(html: string): { src: string; subtitles: Subtitle[] }[] {
  const out: { src: string; subtitles: Subtitle[] }[] = []
  for (const m of html.matchAll(/vidstackPlayer\(JSON\.parse\('((?:[^'\\]|\\.)*)'\)/g)) {
    const p = JSON.parse(JSON.parse(`"${(m[1] as string).replace(/\\'/g, "'")}"`)) as ApiPlayer
    const subtitles: Subtitle[] = []
    for (const s of p.subtitles ?? []) {
      if (s.format !== 'ass' && s.format !== 'vtt' && s.format !== 'srt') continue
      subtitles.push({ lang: s.language, label: s.title, url: s.file, format: s.format, default: s.default })
    }
    out.push({ src: p.src, subtitles })
  }
  return out
}

const unescapeAttr = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

export function createAniZone(fetcher: Fetcher): Source {
  const page = async (path: string) => {
    const res = await fetcher.request(`${BASE}${path}`)
    if (res.status !== 200) {
      await res.body.cancel()
      throw new Error(`anizone: HTTP ${res.status} for ${path}`)
    }
    return { html: await res.body.text(), cookies: res.headers.getSetCookie().map((c) => c.split(';')[0] ?? '') }
  }

  /** Long shows: the episode list pages through Livewire's loadPage(cursor), 24 at a time. */
  async function morePages(slug: string, html: string, cookies: string[], cursor: string) {
    const token = html.match(/name="csrf-token" content="([^"]+)"/)?.[1]
    let snapshot = [...html.matchAll(/wire:snapshot="([^"]+)"/g)]
      .map((m) => unescapeAttr(m[1] as string))
      .find((s) => s.includes('"pages.anime-detail"'))
    if (!token || !snapshot) throw new Error('anizone: no Livewire snapshot/CSRF token on the show page')
    const items: ApiEpisode[] = []
    let next: string | null = cursor
    for (let i = 0; next && i < MAX_PAGES; i++) {
      const res = await fetcher.request(`${BASE}/livewire/update`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-livewire': '1',
          cookie: cookies.join('; '),
          referer: `${BASE}/anime/${slug}`,
          origin: BASE,
        },
        body: JSON.stringify({
          _token: token,
          components: [{ snapshot, updates: {}, calls: [{ path: '', method: 'loadPage', params: [next] }] }],
        }),
      })
      if (res.status !== 200) {
        await res.body.cancel()
        throw new Error(`anizone: Livewire HTTP ${res.status}`)
      }
      const json = await res.body.json<{
        components: {
          snapshot: string
          effects: { dispatches?: { name: string; params: { items: ApiEpisode[]; nextCursor: string | null; hasMore: boolean } }[] }
        }[]
      }>()
      const c = json.components[0]
      const loaded = c?.effects.dispatches?.find((d) => d.name === 'items-loaded')?.params
      if (!c || !loaded) throw new Error('anizone: Livewire reply without items-loaded')
      snapshot = c.snapshot
      items.push(...loaded.items)
      next = loaded.hasMore ? loaded.nextCursor : null
    }
    return items
  }

  return {
    id: 'anizone',
    name: 'AniZone',
    baseUrl: BASE,

    async search(query) {
      return parseSearch((await page(`/anime?search=${encodeURIComponent(query)}`)).html)
    },

    async getShow(slug) {
      const { html, cookies } = await page(`/anime/${encodeURIComponent(slug)}`)
      const show = parseShowPage(html)
      const items = [...show.items]
      if (show.hasMore && show.nextCursor) items.push(...(await morePages(slug, html, cookies, show.nextCursor)))
      const episodes = parseEpisodeItems(slug, items)
      const unique = [...new Map(episodes.map((e) => [e.number, e])).values()].sort((a, b) => a.number - b.number)
      return { id: slug, title: show.title, episodes: unique }
    },

    episodeId: (slug, n) => `${slug}/${n}`,

    /** episodeId = "<slug>/<episode>". One stream per video; dub = the master's English audio track, if any. */
    async getStreams(episodeId, { audio = 'sub' } = {}) {
      if (!/^[a-z0-9]+\/\d+(\.\d+)?$/.test(episodeId)) {
        throw new Error(`anizone: bad episode id "${episodeId}" (want <slug>/<episode>)`)
      }
      const players = parseEpisodePage((await page(`/anime/${episodeId}`)).html)
      if (!players.length) throw new Error(`anizone: no player on episode page ${episodeId}`)
      const servers: Server[] = []
      for (const [i, p] of players.entries()) {
        if (audio === 'dub') {
          const res = await fetcher.request(p.src)
          const master = await res.body.text()
          if (!/TYPE=AUDIO[^\n]*LANGUAGE="en"/.test(master)) continue
        }
        servers.push({
          name: players.length > 1 ? `AniZone ${i + 1}` : 'AniZone',
          streams: [{ url: p.src, type: 'hls', quality: 'auto', headers: {}, audioLang: audio === 'dub' ? 'en' : 'ja' }],
          subtitles: p.subtitles,
        })
      }
      if (!servers.length) throw new Error(`anizone: no ${audio} audio for ${episodeId}`)
      return { servers }
    },

    health: () => checkHealth(fetcher, `${BASE}/anime`),
  }
}

export const anizone: SourceDefinition = {
  id: 'anizone',
  name: 'AniZone',
  hostRules: [{ match: 'anizone.to', rateLimit: { requests: 1, perMs: 1000 }, concurrency: 2 }],
  create: createAniZone,
}
