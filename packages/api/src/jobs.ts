// Scheduled jobs inside the API process. Each runs under a Postgres advisory lock and only when its last successful
// run is older than its interval (job_runs), so two API instances or a restart never double-run one.
import { type AniList, type CatalogStore, type Fetcher, type Source, updateOfflineDb } from '@reconsumet/core'
import { type Db, pruneCache, recordHealth, runJobIfDue } from '@reconsumet/db'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export interface JobDeps {
  db: Db
  fetcher: Fetcher
  catalog: CatalogStore
  anilist: Pick<AniList, 'sync'>
  sources: Map<string, Source>
}

export interface Job {
  name: string
  every: number
  run: () => Promise<unknown>
}

export function jobList(deps: JobDeps): Job[] {
  const { db, fetcher, catalog, anilist, sources } = deps
  return [
    { name: 'catalog-update', every: 7 * DAY, run: () => updateOfflineDb(fetcher, catalog) },
    { name: 'anilist-sync', every: DAY, run: () => anilist.sync(catalog) }, // ~4 requests, under the daily cap
    {
      name: 'source-health',
      every: 15 * MIN,
      run: async () => {
        const out: Record<string, boolean> = {}
        for (const s of sources.values()) {
          const h = await s.health()
          await recordHealth(db, s.id, h)
          out[s.id] = h.ok
        }
        return out
      },
    },
    { name: 'cache-prune', every: DAY, run: () => pruneCache(db) },
  ]
}

/** Check every job now and then every `tickMs`; returns a stop function. */
export function startJobs(deps: JobDeps, tickMs = 5 * MIN): () => void {
  const jobs = jobList(deps)
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      for (const j of jobs) {
        const r = await runJobIfDue(deps.db, j.name, j.every, j.run)
        if (r.error) console.error(`job ${j.name} failed: ${r.error}`)
        else if (r.ran) console.log(`job ${j.name} done`)
      }
    } catch (e) {
      console.error('job tick failed', e)
    } finally {
      running = false
    }
  }
  const first = setTimeout(tick, 5_000)
  const timer = setInterval(tick, tickMs)
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
