#!/usr/bin/env node
// `reconsumet` — dev/test CLI for the library. Data lives in RECONSUMET_DATA_DIR (default ./data).
import { parseArgs } from 'node:util'
import { createAniList } from '../anilist/client.ts'
import { FileCatalogStore } from '../catalog/file-store.ts'
import { updateOfflineDb } from '../catalog/offline-db.ts'
import { dataDir } from '../data.ts'
import { createSources, getSourceDefinition } from '../sources/registry.ts'
import type { Source } from '../sources/types.ts'

const HELP = `reconsumet — RECONSUMΣT.TS dev CLI

Usage:
  reconsumet catalog update [--force]       import the anime offline database (skips if unchanged)
  reconsumet catalog search <query>         search the local catalog
  reconsumet anilist sync                   merge AniList's airing / upcoming / recently updated into the catalog
  reconsumet search <source> <query>        search one source (reanime, anizone)
  reconsumet health                         is each source up and unblocked?

Options:
  --json        machine-readable output
  -v, --verbose log every HTTP request to stderr
  -h, --help    this help

Environment:
  RECONSUMET_DATA_DIR            data dir (default ./data)
  RECONSUMET_ANILIST_DAILY_CAP   AniList requests per UTC day (default 300)`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    force: { type: 'boolean' },
    json: { type: 'boolean' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
})

const [cmd, sub, ...rest] = positionals
const out = (v: unknown) => console.log(values.json ? JSON.stringify(v, null, 2) : v)

async function main() {
  if (values.help || !cmd) return console.log(HELP)
  const { fetcher, sources } = createSources({
    onEvent: values.verbose
      ? (e) => console.error(`${e.tier} ${e.status ?? e.error} ${e.ms}ms ${e.url.slice(0, 120)}`)
      : undefined,
  })
  const catalog = new FileCatalogStore(dataDir())
  const anilist = createAniList({ fetcher, dir: dataDir() })
  const source = (id: string | undefined) => {
    if (!id) throw new Error(`which source? (${[...sources.keys()].join(', ')})`)
    getSourceDefinition(id)
    return sources.get(id) as Source
  }
  try {
    if (cmd === 'search') {
      const hits = await source(sub).search(rest.join(' '))
      if (values.json) return out(hits)
      for (const h of hits) {
        console.log(`${h.id}\t${h.type ?? '?'}\t${h.year ?? '?'}\t${h.episodes ?? '?'}\t${h.anilistId ?? '-'}\t${h.title}`)
      }
      return
    }
    if (cmd === 'health') {
      const rows = await Promise.all([...sources.values()].map(async (s) => ({ source: s.id, ...(await s.health()) })))
      if (values.json) return out(rows)
      for (const r of rows) {
        console.log(`${r.ok ? 'ok  ' : 'FAIL'}\t${r.source}\t${r.status ?? '-'}\t${r.class}\t${r.ms}ms${r.error ? `\t${r.error}` : ''}`)
      }
      if (rows.some((r) => !r.ok)) process.exitCode = 1
      return
    }
    if (cmd === 'catalog' && sub === 'update') {
      const r = await updateOfflineDb(fetcher, catalog, { force: values.force })
      out(r.skipped ? { skipped: true, reason: 'release unchanged', ...r.meta } : { imported: true, ...r.meta })
      return
    }
    if (cmd === 'anilist' && sub === 'sync') {
      const r = await anilist.sync(catalog)
      out({ ...r, usage: await anilist.usage(), catalogEntries: await catalog.count() })
      return
    }
    if (cmd === 'catalog' && sub === 'search') {
      const hits = await catalog.search(rest.join(' '), 10)
      if (values.json) return out(hits)
      for (const e of hits) console.log(`${e.anilistId ?? '-'}\t${e.type}\t${e.year ?? '?'}\t${e.episodes}\t${e.title}`)
      return
    }
    console.error(`unknown command: ${positionals.join(' ')}\n`)
    console.log(HELP)
    process.exitCode = 2
  } finally {
    await fetcher.close()
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e)
  process.exitCode = 1
})
