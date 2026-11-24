#!/usr/bin/env node
// `reconsumet` — dev/test CLI for the library. Data lives in RECONSUMET_DATA_DIR (default ./data).
import { parseArgs } from 'node:util'
import { createAniList } from '../anilist/client.ts'
import { FileCatalogStore } from '../catalog/file-store.ts'
import { updateOfflineDb } from '../catalog/offline-db.ts'
import { dataDir } from '../data.ts'
import { createMatcher, fileMappingStore } from '../match/index.ts'
import { createSources, getSourceDefinition } from '../sources/registry.ts'
import type { Source } from '../sources/types.ts'

const HELP = `reconsumet — RECONSUMΣT.TS dev CLI

Usage:
  reconsumet catalog update [--force]       import the anime offline database (skips if unchanged)
  reconsumet catalog search <query>         search the local catalog
  reconsumet anilist sync                   merge AniList's airing / upcoming / recently updated into the catalog
  reconsumet search <source> <query>        search one source (reanime, anizone)
  reconsumet health                         is each source up and unblocked?
  reconsumet match <anilistId> [--source s] [--refresh]
                                            which show + episode offset on each source
  reconsumet streams <anilistId> <episode> [--source s] [--dub] [--json]
                                            playable streams + subtitles (first source that has them)

Options:
  -s, --source  one source instead of all (in preference order: reanime, anizone)
  --dub         English audio instead of Japanese with subtitles
  --refresh     ignore the cached mapping
  --force       re-import even if the release is unchanged
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
    source: { type: 'string', short: 's' },
    dub: { type: 'boolean' },
    refresh: { type: 'boolean' },
    json: { type: 'boolean' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
})

const [cmd, sub, ...rest] = positionals
const out = (v: unknown) => console.log(values.json ? JSON.stringify(v, null, 2) : v)
const anilistIdArg = (s: string | undefined) => {
  if (!s || !/^\d+$/.test(s)) throw new Error(`expected an AniList ID, got "${s ?? ''}"`)
  return Number(s)
}

async function main() {
  if (values.help || !cmd) return console.log(HELP)
  const { fetcher, sources } = createSources({
    onEvent: values.verbose
      ? (e) => console.error(`${e.tier} ${e.status ?? e.error} ${e.ms}ms ${e.url.slice(0, 120)}`)
      : undefined,
  })
  const catalog = new FileCatalogStore(dataDir())
  const anilist = createAniList({ fetcher, dir: dataDir() })
  const matcher = createMatcher({ media: anilist.media, catalog, store: fileMappingStore(dataDir()) })
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
    if (cmd === 'match') {
      const id = anilistIdArg(sub)
      const list = values.source ? [source(values.source)] : [...sources.values()]
      const rows = []
      for (const s of list) rows.push(await matcher.match(id, s, { refresh: values.refresh }))
      if (values.json) return out(rows)
      for (const r of rows) {
        const where = r.showId
          ? `${r.showId}  "${r.title ?? ''}"  confidence ${r.confidence}  offset ${r.episodeOffset}${r.episodeRange ? `  range ${r.episodeRange.join('-')}` : ''}`
          : 'no match'
        console.log(`${r.sourceId}\t${where}\n\t${r.reasons.join('; ')}`)
      }
      return
    }
    if (cmd === 'streams') {
      const id = anilistIdArg(sub)
      const episode = Number(rest[0])
      if (!Number.isFinite(episode) || episode <= 0) throw new Error('usage: streams <anilistId> <episode>')
      const audio = values.dub ? 'dub' : 'sub'
      const list = values.source ? [source(values.source)] : [...sources.values()]
      const errors: string[] = []
      for (const s of list) {
        try {
          const r = await matcher.resolveEpisode(id, episode, s)
          const streams = await s.getStreams(r.episodeId, { audio })
          const result = { source: s.id, anilistId: id, episode, ...r, audio, ...streams }
          if (values.json) return out(result)
          console.log(`${s.id}: ${r.match.title ?? r.match.showId} — source episode ${r.sourceEpisode} (${r.episodeId}), ${audio}`)
          for (const sv of streams.servers) {
            console.log(`  ${sv.name}${sv.intro ? `  intro ${sv.intro.start}-${sv.intro.end}s` : ''}`)
            for (const st of sv.streams) {
              const flags = [st.audioLang && `audio=${st.audioLang}`, st.playlistKey && 'xor-playlists', st.ipLocked && 'ip-locked']
              console.log(`    ${st.type} ${st.quality} ${st.url}  ${flags.filter(Boolean).join(' ')}`)
              if (Object.keys(st.headers).length) console.log(`      headers ${JSON.stringify(st.headers)}`)
            }
            const subs = sv.subtitles
            console.log(`    subtitles: ${subs.length} (${[...new Set(subs.map((x) => `${x.lang}/${x.format}`))].join(', ')})`)
            const def = subs.find((x) => x.default) ?? subs[0]
            if (def) console.log(`      default: ${def.label} ${def.url}`)
          }
          return
        } catch (e) {
          errors.push(`${s.id}: ${(e as Error).message}`)
        }
      }
      throw new Error(`no streams.\n  ${errors.join('\n  ')}`)
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
