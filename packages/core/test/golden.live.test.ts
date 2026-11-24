// Live golden set: real AniList (through the data dir's cache) + real source searches.
// RECORD=1 also rewrites src/match/__fixtures__/golden-recorded.json for the offline replay test.
// Needs the catalog in <repo>/data (reconsumet catalog update) for synonyms.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createAniList } from '../src/anilist/client.ts'
import { FileCatalogStore } from '../src/catalog/file-store.ts'
import type { CatalogEntry } from '../src/catalog/types.ts'
import { matchSource } from '../src/match/matcher.ts'
import { createSources } from '../src/sources/registry.ts'
import type { SearchResult } from '../src/sources/types.ts'
import { GOLDEN_SOURCES, goldenCases, RECORDING, report } from './golden.ts'

const DATA = fileURLToPath(new URL('../../../data', import.meta.url))

it('golden set matches on the live sites', { timeout: 30 * 60_000 }, async () => {
  const { fetcher, sources } = createSources()
  const anilist = createAniList({ fetcher, dir: DATA })
  const catalog = new FileCatalogStore(DATA)
  const rec = {
    media: {} as Record<number, unknown>,
    catalog: {} as Record<number, CatalogEntry | null>,
    search: {} as Record<string, SearchResult[]>,
  }
  const deps = {
    media: async (id: number) => {
      const m = await anilist.media(id)
      // record only what the matcher reads (keeps the fixture small)
      rec.media[id] = m && {
        id: m.id,
        title: m.title,
        synonyms: m.synonyms,
        format: m.format,
        episodes: m.episodes,
        status: m.status,
        seasonYear: m.seasonYear,
        startDate: m.startDate,
        relations: {
          edges: m.relations?.edges.filter((e) => e.relationType === 'PREQUEL' || e.relationType === 'SEQUEL'),
        },
      }
      return m
    },
    catalog: {
      get: async (ref: { anilistId?: number }) => {
        const e = await catalog.get(ref)
        rec.catalog[ref.anilistId as number] = e ?? null
        return e
      },
    },
  }
  const rows = []
  try {
    for (const c of goldenCases()) {
      for (const id of GOLDEN_SOURCES) {
        const s = sources.get(id)
        if (!s) throw new Error(id)
        const recording = {
          id: s.id,
          search: async (q: string) => {
            const r = await s.search(q)
            rec.search[`${s.id}|${q}`] = r
            return r
          },
        }
        rows.push({ c, source: id, got: await matchSource(c.anilistId, recording, deps) })
      }
    }
  } finally {
    await fetcher.close()
  }
  if (process.env.RECORD) writeFileSync(RECORDING, `${JSON.stringify(rec)}\n`)
  const per = report(rows)
  // sites change; flag a real regression, not one show going missing
  for (const p of Object.values(per)) expect(p.ok / p.total).toBeGreaterThanOrEqual(0.9)
})
