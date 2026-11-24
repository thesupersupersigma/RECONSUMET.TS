// Direct-playback probe (brainstorm 1.21/2.5): could a player on our site load this URL straight from the CDN?
// For one URL it tries plain vs impersonate, each with three header sets, and reports status + the CORS header:
//   bare    – no Referer/Origin (curl-like)
//   ours    – what a browser on our site sends cross-origin (Origin + Referer = our site)
//   source  – the source's own Referer/Origin (what a relay would have to add)
// Direct playback works only if `ours` gets 200 with a matching Access-Control-Allow-Origin on the plain tier.
// Usage: node tools/playback-check/probe.ts <url> [--referer https://source-site/]
import { createFetcher } from '../../packages/core/src/index.ts'

const SITE = 'https://thesupersuperanime.lol'

export interface ProbeRow {
  tier: 'plain' | 'impersonate'
  headers: 'bare' | 'ours' | 'source'
  status: number | string
  acao: string | null
  bytes: number
}

export async function probe(url: string, referer?: string): Promise<ProbeRow[]> {
  const sets: Record<string, Record<string, string>> = { bare: {}, ours: { origin: SITE, referer: `${SITE}/` } }
  if (referer) sets.source = { origin: new URL(referer).origin, referer }
  const f = createFetcher({ retry: { attempts: 0 } })
  const rows: ProbeRow[] = []
  try {
    for (const tier of ['plain', 'impersonate'] as const) {
      for (const [name, headers] of Object.entries(sets)) {
        const row: ProbeRow = { tier, headers: name as ProbeRow['headers'], status: 0, acao: null, bytes: 0 }
        try {
          const r = await f.request(url, { tier, headers, maxBytes: 8 << 20 })
          row.bytes = (await r.body.bytes()).length
          row.status = r.status
          row.acao = r.headers.get('access-control-allow-origin')
        } catch (e) {
          const status = (e as { status?: number }).status
          row.status = `${(e as Error).name}${status ? ` ${status}` : ''}`
        }
        rows.push(row)
      }
    }
  } finally {
    await f.close()
  }
  return rows
}

if (import.meta.main) {
  const [url, flag, ref] = process.argv.slice(2)
  if (!url) throw new Error('usage: probe.ts <url> [--referer <url>]')
  console.table(await probe(url, flag === '--referer' ? ref : undefined))
}
