// Offline golden set: replays the recorded AniList answers, catalog entries and source searches
// (src/match/__fixtures__/golden-recorded.json, written by `RECORD=1 pnpm test:live`) through the matcher.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AniListMedia } from '../src/anilist/client.ts'
import type { CatalogEntry } from '../src/catalog/types.ts'
import { matchSource } from '../src/match/matcher.ts'
import type { SearchResult } from '../src/sources/types.ts'
import { GOLDEN_SOURCES, goldenCases, isCorrect, RECORDING, report } from './golden.ts'

const rec = JSON.parse(readFileSync(RECORDING, 'utf8')) as {
  media: Record<string, AniListMedia | null>
  catalog: Record<string, CatalogEntry | null>
  search: Record<string, SearchResult[]>
}

const deps = {
  media: async (id: number) => {
    if (!(id in rec.media)) throw new Error(`not recorded: AniList ${id} (re-record with RECORD=1 pnpm test:live)`)
    return rec.media[id] ?? null
  },
  catalog: { get: async (r: { anilistId?: number }) => rec.catalog[r.anilistId as number] ?? undefined },
}

const replay = (id: string) => ({
  id,
  search: async (q: string) => {
    const r = rec.search[`${id}|${q}`]
    if (!r) throw new Error(`not recorded: ${id} search "${q}"`)
    return r
  },
})

describe('golden set (recorded)', () => {
  const rows: Parameters<typeof report>[0] = []
  for (const c of goldenCases()) {
    for (const source of GOLDEN_SOURCES) {
      it(`${source} ${c.anilistId} ${c.note}`, async () => {
        const got = await matchSource(c.anilistId, replay(source), deps)
        rows.push({ c, source, got })
        expect(isCorrect(c.expected[source] ?? null, got), got.reasons.join('; ')).toBe(true)
      })
    }
  }
  it('precision report', () => {
    const per = report(rows)
    for (const p of Object.values(per)) expect(p.ok).toBe(p.total)
  })
})
