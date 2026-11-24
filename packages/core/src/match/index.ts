import { join } from 'node:path'
import { readJson, writeJson } from '../data.ts'
import type { Source } from '../sources/types.ts'
import { type MatchDeps, type MatchResult, matchSource } from './matcher.ts'

export { type MatchDeps, type MatchResult, matchSource, queriesFor, stripStructure, THRESHOLD } from './matcher.ts'
export { normalizeTitle, parseTitle, similarity } from './title.ts'

/** A hand-written fix in `<data dir>/overrides.json`, keyed "<sourceId>:<anilistId>". showId null = "not on this source". */
export interface Override {
  showId: string | null
  episodeOffset?: number
  episodeRange?: [number, number]
  note?: string
}

const DAY = 86_400_000

/**
 * Matching with a mapping cache (`mappings.json`, 7 days for a match, 1 day for "no match") and manual overrides.
 * shortcut: two JSON files in the data dir; Postgres tables in 0.4.
 */
export function createMatcher(deps: MatchDeps & { dir: string }) {
  const mappingsFile = join(deps.dir, 'mappings.json')
  const overridesFile = join(deps.dir, 'overrides.json')

  async function match(anilistId: number, source: Pick<Source, 'id' | 'search'>, { refresh = false } = {}) {
    const key = `${source.id}:${anilistId}`
    const override = (await readJson<Record<string, Override>>(overridesFile))?.[key]
    if (override) {
      return {
        sourceId: source.id,
        anilistId,
        showId: override.showId,
        confidence: 1,
        episodeOffset: override.episodeOffset ?? 0,
        ...(override.episodeRange ? { episodeRange: override.episodeRange } : {}),
        reasons: [`manual override${override.note ? `: ${override.note}` : ''}`],
      } satisfies MatchResult
    }
    const cache = (await readJson<Record<string, { at: number; result: MatchResult }>>(mappingsFile)) ?? {}
    const hit = cache[key]
    if (hit && !refresh && Date.now() - hit.at < (hit.result.showId ? 7 * DAY : DAY)) return hit.result
    const result = await matchSource(anilistId, source, deps)
    cache[key] = { at: Date.now(), result }
    await writeJson(mappingsFile, cache)
    return result
  }

  /** AniList episode → the source's episode id, through the mapping. */
  async function resolveEpisode(anilistId: number, episode: number, source: Source) {
    const m = await match(anilistId, source)
    if (!m.showId) throw new Error(`${source.id}: no match for AniList ${anilistId} (${m.reasons.join('; ')})`)
    if (m.episodeRange && episode > m.episodeRange[1] - m.episodeRange[0] + 1) {
      throw new Error(`${source.id}: AniList ${anilistId} has ${m.episodeRange[1] - m.episodeRange[0] + 1} episodes here`)
    }
    const sourceEpisode = episode + m.episodeOffset
    return { match: m, sourceEpisode, episodeId: source.episodeId(m.showId, sourceEpisode) }
  }

  return { match, resolveEpisode }
}
