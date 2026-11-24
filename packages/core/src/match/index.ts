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

/** Where mappings + overrides live: JSON files for the CLI (fileMappingStore), Postgres tables for the API. */
export interface MappingStore {
  override(sourceId: string, anilistId: number): Promise<Override | undefined>
  get(sourceId: string, anilistId: number): Promise<{ at: number; result: MatchResult } | undefined>
  set(result: MatchResult): Promise<void>
}

/** `<dir>/mappings.json` + `<dir>/overrides.json`, keyed "<sourceId>:<anilistId>". */
export function fileMappingStore(dir: string): MappingStore {
  const mappingsFile = join(dir, 'mappings.json')
  const overridesFile = join(dir, 'overrides.json')
  const mappings = async () =>
    (await readJson<Record<string, { at: number; result: MatchResult }>>(mappingsFile)) ?? {}
  return {
    override: async (s, a) => (await readJson<Record<string, Override>>(overridesFile))?.[`${s}:${a}`],
    get: async (s, a) => (await mappings())[`${s}:${a}`],
    async set(result) {
      const all = await mappings()
      all[`${result.sourceId}:${result.anilistId}`] = { at: Date.now(), result }
      await writeJson(mappingsFile, all)
    },
  }
}

/** Matching with a mapping cache (7 days for a match, 1 day for "no match") and manual overrides. */
export function createMatcher(deps: MatchDeps & { store: MappingStore }) {
  const { store } = deps

  async function match(anilistId: number, source: Pick<Source, 'id' | 'search'>, { refresh = false } = {}) {
    const override = await store.override(source.id, anilistId)
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
    const hit = await store.get(source.id, anilistId)
    if (hit && !refresh && Date.now() - hit.at < (hit.result.showId ? 7 * DAY : DAY)) return hit.result
    const result = await matchSource(anilistId, source, deps)
    await store.set(result)
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
