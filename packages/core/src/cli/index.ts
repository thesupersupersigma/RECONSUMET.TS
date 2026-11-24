#!/usr/bin/env node
// `reconsumet` — dev/test CLI for the library. Data lives in RECONSUMET_DATA_DIR (default ./data).
import { parseArgs } from 'node:util'
import { FileCatalogStore } from '../catalog/file-store.ts'
import { updateOfflineDb } from '../catalog/offline-db.ts'
import { dataDir } from '../data.ts'
import { createFetcher } from '../fetch/fetcher.ts'

const HELP = `reconsumet — RECONSUMΣT.TS dev CLI

Usage:
  reconsumet catalog update [--force]       import the anime offline database (skips if unchanged)
  reconsumet catalog search <query>         search the local catalog

Options:
  --json        machine-readable output
  -v, --verbose log every HTTP request to stderr
  -h, --help    this help

Environment:
  RECONSUMET_DATA_DIR   data dir (default ./data)`

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
  const fetcher = createFetcher({
    onEvent: values.verbose
      ? (e) => console.error(`${e.tier} ${e.status ?? e.error} ${e.ms}ms ${e.url.slice(0, 120)}`)
      : undefined,
  })
  const catalog = new FileCatalogStore(dataDir())
  try {
    if (cmd === 'catalog' && sub === 'update') {
      const r = await updateOfflineDb(fetcher, catalog, { force: values.force })
      out(r.skipped ? { skipped: true, reason: 'release unchanged', ...r.meta } : { imported: true, ...r.meta })
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
