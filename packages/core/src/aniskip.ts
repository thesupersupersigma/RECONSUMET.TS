// AniSkip (https://api.aniskip.com, third-party, no key): crowd-sourced opening/ending times by MAL ID + episode.
// Only used when a stream's server has no intro/outro of its own.
import type { AniListCache } from './anilist/client.ts'
import type { Fetcher } from './fetch/index.ts'

export const ANISKIP_URL = 'https://api.aniskip.com'

export interface Interval {
  start: number
  end: number
}
export interface SkipTimes {
  intro?: Interval
  outro?: Interval
  source: 'aniskip' | 'none'
}

interface Result {
  interval: { startTime: number; endTime: number }
  skipType: 'op' | 'ed' | 'mixed-op' | 'mixed-ed'
}

const HOUR = 3_600_000
const FOUND_TTL = 7 * 24 * HOUR
const MISS_TTL = 6 * HOUR // people submit times for new episodes, so look again sooner

export function createAniSkip(opts: { fetcher: Fetcher; cache: AniListCache; url?: string }) {
  const base = (opts.url ?? ANISKIP_URL).replace(/\/$/, '')
  return {
    /** Skip times for one episode of `durationSec` (AniSkip only answers for a matching episode length). */
    async skipTimes(malId: number, episode: number, durationSec: number): Promise<SkipTimes> {
      const length = Math.round(durationSec)
      const key = `skip:${malId}:${episode}:${length}`
      const hit = await opts.cache.get<SkipTimes>(key)
      if (hit) return hit
      const types = ['op', 'ed', 'mixed-op', 'mixed-ed'].map((t) => `types[]=${t}`).join('&')
      const res = await opts.fetcher.request(
        `${base}/v2/skip-times/${malId}/${episode}?${types}&episodeLength=${length}`,
        {
          headers: { accept: 'application/json' },
        },
      )
      if (res.status !== 200 && res.status !== 404) {
        await res.body.cancel()
        throw new Error(`AniSkip: HTTP ${res.status}`)
      }
      const json = await res.body.json<{ found?: boolean; results?: Result[] }>()
      const pick = (...types: Result['skipType'][]): Interval | undefined => {
        for (const t of types) {
          const r = json.results?.find((x) => x.skipType === t)
          if (r) return { start: r.interval.startTime, end: r.interval.endTime }
        }
        return undefined
      }
      const intro = pick('op', 'mixed-op')
      const outro = pick('ed', 'mixed-ed')
      const out: SkipTimes =
        intro || outro
          ? { ...(intro ? { intro } : {}), ...(outro ? { outro } : {}), source: 'aniskip' }
          : { source: 'none' }
      await opts.cache.set(key, out, out.source === 'aniskip' ? FOUND_TTL : MISS_TTL)
      return out
    },
  }
}

export type AniSkip = ReturnType<typeof createAniSkip>
