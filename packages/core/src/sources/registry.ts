import { ANILIST_HOST_RULE } from '../anilist/client.ts'
import { createFetcher, type Fetcher } from '../fetch/index.ts'
import type { FetcherConfig, HostRule } from '../fetch/types.ts'
import { anizone } from './anizone/index.ts'
import { reanime } from './reanime/index.ts'
import type { Source, SourceDefinition } from './types.ts'

/** Every source, in default preference order. */
export const SOURCES: SourceDefinition[] = [reanime, anizone]

export function getSourceDefinition(id: string): SourceDefinition {
  const def = SOURCES.find((s) => s.id === id)
  if (!def) throw new Error(`unknown source "${id}" (have: ${SOURCES.map((s) => s.id).join(', ')})`)
  return def
}

/** Host rules of every source + AniList, for one shared fetcher. */
export function allHostRules(): HostRule[] {
  return [ANILIST_HOST_RULE, ...SOURCES.flatMap((s) => s.hostRules)]
}

/** A fetcher configured for all sources, plus each source instantiated on it. */
export function createSources(config: FetcherConfig = {}): { fetcher: Fetcher; sources: Map<string, Source> } {
  const fetcher = createFetcher({ ...config, rules: [...allHostRules(), ...(config.rules ?? [])] })
  return { fetcher, sources: new Map(SOURCES.map((d) => [d.id, d.create(fetcher)])) }
}
