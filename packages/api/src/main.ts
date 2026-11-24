#!/usr/bin/env node
// The API service: migrations (under a lock) → HTTP server → scheduled jobs.
import { serve } from '@hono/node-server'
import { createAniList, createSources } from '@reconsumet/core'
import { connect, ensureApiKey, migrate, PgCatalogStore, pgCache } from '@reconsumet/db'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { startJobs } from './jobs.ts'

const config = loadConfig()
const db = connect(config.databaseUrl)
await migrate(db)
if (config.bootstrapKey) {
  const { key, name, rateLimit } = config.bootstrapKey
  const created = await ensureApiKey(db, name, key, rateLimit)
  console.log(created ? `bootstrap API key "${name}" created` : 'bootstrap API key already present') // never the value
}

const { fetcher, sources } = createSources()
const anilist = createAniList({ fetcher, cache: pgCache(db, 'anilist') })
const app = createApp({ config, db, sources, anilist })
const stopJobs = config.jobs ? startJobs({ db, fetcher, catalog: new PgCatalogStore(db), anilist, sources }) : () => {}

const server = serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`api listening on :${i.port}`))

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    stopJobs()
    server.close(async () => {
      await fetcher.close()
      await db.close()
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 10_000).unref()
  })
}
