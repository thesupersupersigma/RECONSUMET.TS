// Import of manami-project/anime-offline-database (ODbL 1.0 + DbCL 1.0, see docs/catalog.md).
import type { Fetcher } from '../fetch/index.ts'
import type { CatalogEntry, CatalogStore } from './types.ts'

export const OFFLINE_DB_URL =
  'https://github.com/manami-project/anime-offline-database/releases/download/latest/anime-offline-database-minified.json'

interface ManamiEntry {
  sources: string[]
  title: string
  type: string
  episodes: number
  status: string
  animeSeason?: { season?: string; year?: number | null }
  picture?: string
  duration?: { value: number; unit: string }
  synonyms?: string[]
  tags?: string[]
}

const ID_PATTERNS = {
  anilistId: /^https:\/\/anilist\.co\/anime\/(\d+)$/,
  malId: /^https:\/\/myanimelist\.net\/anime\/(\d+)$/,
  kitsuId: /^https:\/\/kitsu\.(?:app|io)\/anime\/(\d+)$/,
  anidbId: /^https:\/\/anidb\.net\/anime\/(\d+)$/,
} as const

export function normalizeManami(m: ManamiEntry): CatalogEntry {
  const e: CatalogEntry = {
    title: m.title,
    synonyms: m.synonyms ?? [],
    type: m.type,
    episodes: m.episodes ?? 0,
    status: m.status,
    season: m.animeSeason?.season && m.animeSeason.season !== 'UNDEFINED' ? m.animeSeason.season : null,
    year: m.animeSeason?.year ?? null,
    picture: m.picture ?? null,
    duration: m.duration ? m.duration.value * (m.duration.unit === 'SECONDS' ? 1 : 60) : null,
    ...(m.tags ? { isAdult: m.tags.includes('hentai') } : {}),
  }
  for (const src of m.sources) {
    for (const [k, re] of Object.entries(ID_PATTERNS)) {
      const id = src.match(re)?.[1]
      if (id) e[k as keyof typeof ID_PATTERNS] = Number(id)
    }
  }
  return e
}

export interface OfflineDbMeta {
  etag: string | null
  lastUpdate: string
  importedAt: string
  entries: number
}

/** Download + import, unless the release is unchanged (ETag, then the file's own `lastUpdate`). */
export async function updateOfflineDb(
  fetcher: Fetcher,
  store: CatalogStore,
  { force = false, url = OFFLINE_DB_URL } = {},
): Promise<{ skipped: boolean; meta: OfflineDbMeta }> {
  const old = await store.getMeta<OfflineDbMeta>('offline-db')
  const headers: Record<string, string> = {}
  if (old?.etag && !force) headers['if-none-match'] = old.etag
  const res = await fetcher.request(url, { headers, maxBytes: 256 << 20, timeout: { totalMs: 15 * 60_000 } })
  if (res.status === 304 && old) {
    await res.body.cancel()
    return { skipped: true, meta: old }
  }
  if (res.status !== 200) {
    await res.body.cancel()
    throw new Error(`offline database download failed: HTTP ${res.status}`)
  }
  const json = await res.body.json<{ lastUpdate: string; data: ManamiEntry[] }>()
  if (!Array.isArray(json.data)) throw new Error('offline database: unexpected format (no data[])')
  const meta: OfflineDbMeta = {
    etag: res.headers.get('etag'),
    lastUpdate: json.lastUpdate,
    importedAt: new Date().toISOString(),
    entries: json.data.length,
  }
  if (old && old.lastUpdate === json.lastUpdate && !force) {
    await store.setMeta('offline-db', { ...old, etag: meta.etag })
    return { skipped: true, meta: old }
  }
  await store.upsert(json.data.map(normalizeManami))
  await store.setMeta('offline-db', meta)
  return { skipped: false, meta }
}
