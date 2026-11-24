import { join } from 'node:path'
import { readJson, writeJson } from '../data.ts'
import { normalizeTitle } from '../match/title.ts'
import type { CatalogEntry, CatalogRef, CatalogStore } from './types.ts'

const ID_KEYS = ['anilistId', 'malId', 'kitsuId', 'anidbId'] as const

/**
 * The whole catalog in memory (~41k entries), persisted as one JSON file in the data dir.
 * shortcut: loads everything on first use and rewrites the file on every upsert; fine for the CLI, replaced by
 * Postgres in 0.4.
 */
export class FileCatalogStore implements CatalogStore {
  private entries: CatalogEntry[] = []
  private names: string[][] = [] // normalized title + synonyms, parallel to entries
  private byId = new Map<string, number>() // "anilistId:123" -> index
  private meta: Record<string, unknown> = {}
  private loaded?: Promise<void>

  readonly dir: string
  constructor(dir: string) {
    this.dir = dir
  }

  private load() {
    this.loaded ??= (async () => {
      const file = await readJson<{ entries: CatalogEntry[]; meta: Record<string, unknown> }>(this.file)
      this.meta = file?.meta ?? {}
      for (const e of file?.entries ?? []) this.put(e, this.entries.length)
    })()
    return this.loaded
  }

  private get file() {
    return join(this.dir, 'catalog.json')
  }

  private put(e: CatalogEntry, i: number) {
    this.entries[i] = e
    this.names[i] = [...new Set([e.title, ...e.synonyms].map(normalizeTitle))]
    for (const k of ID_KEYS) if (e[k] != null) this.byId.set(`${k}:${e[k]}`, i)
  }

  private find(ref: CatalogRef): number | undefined {
    for (const k of ID_KEYS) {
      if (ref[k] == null) continue
      const i = this.byId.get(`${k}:${ref[k]}`)
      if (i !== undefined) return i
    }
    return undefined
  }

  async get(ref: CatalogRef) {
    await this.load()
    const i = this.find(ref)
    return i === undefined ? undefined : this.entries[i]
  }

  async search(query: string, limit = 20) {
    await this.load()
    const q = normalizeTitle(query)
    if (!q) return []
    const words = q.split(' ')
    const scored: { i: number; score: number }[] = []
    this.names.forEach((names, i) => {
      let best = 0
      for (const n of names) {
        const s = n === q ? 3 : n.startsWith(q) ? 2 : words.every((w) => n.includes(w)) ? 1 : 0
        if (s > best) best = s
      }
      if (best) scored.push({ i, score: best })
    })
    return scored
      .sort((a, b) => b.score - a.score || (this.entries[b.i]?.year ?? 0) - (this.entries[a.i]?.year ?? 0))
      .slice(0, limit)
      .map((s) => this.entries[s.i] as CatalogEntry)
  }

  async upsert(entries: CatalogEntry[]) {
    await this.load()
    for (const e of entries) {
      const i = this.find(e)
      if (i === undefined) {
        this.put(e, this.entries.length)
        continue
      }
      const old = this.entries[i] as CatalogEntry
      const merged: CatalogEntry = { ...old }
      for (const [k, v] of Object.entries(e)) if (v != null && v !== '' && v !== 0) Object.assign(merged, { [k]: v })
      merged.synonyms = [...new Set([...old.synonyms, ...e.synonyms])].filter((s) => s !== merged.title)
      this.put(merged, i)
    }
    await this.save()
  }

  async listAiring() {
    await this.load()
    return this.entries.filter((e) => e.status === 'ONGOING')
  }

  async count() {
    await this.load()
    return this.entries.length
  }

  async getMeta<T>(key: string) {
    await this.load()
    return this.meta[key] as T | undefined
  }

  async setMeta(key: string, value: unknown) {
    await this.load()
    this.meta[key] = value
    await this.save()
  }

  private save() {
    return writeJson(this.file, { entries: this.entries, meta: this.meta })
  }
}
