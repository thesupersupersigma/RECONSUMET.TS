// Golden set helpers shared by the offline replay test and the live (recording) test.
import { readFileSync } from 'node:fs'
import type { MatchResult } from '../src/match/matcher.ts'

export interface Expected {
  showId: string
  episodeOffset: number
}

export interface GoldenCase {
  anilistId: number
  kind: string
  note: string
  expected: Record<string, Expected | null>
}

export const GOLDEN_SOURCES = ['reanime', 'anizone']

export const goldenCases = (): GoldenCase[] =>
  JSON.parse(readFileSync(new URL('../src/match/__fixtures__/golden.json', import.meta.url), 'utf8')).cases

export const RECORDING = new URL('../src/match/__fixtures__/golden-recorded.json', import.meta.url)

export function isCorrect(expected: Expected | null, got: MatchResult): boolean {
  if (expected === null) return got.showId === null
  return got.showId === expected.showId && got.episodeOffset === expected.episodeOffset
}

/** Precision per source + the misses, printed as a table. */
export function report(rows: { c: GoldenCase; source: string; got: MatchResult }[]) {
  const per: Record<string, { ok: number; total: number; misses: string[] }> = {}
  for (const { c, source, got } of rows) {
    const p = (per[source] ??= { ok: 0, total: 0, misses: [] })
    p.total++
    if (isCorrect(c.expected[source] ?? null, got)) p.ok++
    else {
      const want = c.expected[source]
      p.misses.push(
        `${c.anilistId} ${c.note}: want ${want ? `${want.showId}+${want.episodeOffset}` : 'no match'}, got ${got.showId ? `${got.showId}+${got.episodeOffset}` : 'no match'} (${got.reasons.join('; ')})`,
      )
    }
  }
  for (const [s, p] of Object.entries(per)) {
    console.log(`golden ${s}: ${p.ok}/${p.total} = ${((100 * p.ok) / p.total).toFixed(1)}%`)
    for (const m of p.misses) console.log(`  miss ${m}`)
  }
  return per
}
