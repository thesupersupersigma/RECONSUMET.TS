// Direct-playback probe (brainstorm 1.21/2.5): could a player on our site load this URL straight from the CDN?
// For one URL it tries plain vs impersonate, each with three header sets, and reports status + the CORS header:
//   bare    – no Referer/Origin (curl-like)
//   ours    – what a browser on our site sends cross-origin (Origin + Referer = our site)
//   source  – the source's own Referer/Origin (what a relay would have to add)
// Direct playback works only if `ours` gets 200 with a matching Access-Control-Allow-Origin on the plain tier.
// Usage: node tools/playback-check/probe.ts <url> [--referer https://source-site/] [--site https://your-site.example]
// The site origin comes from --site or PROBE_SITE; https://example.com stands in for it otherwise.
import { parseArgs } from 'node:util'
import { createFetcher } from '../../packages/core/src/index.ts'

export interface ProbeRow {
  tier: 'plain' | 'impersonate'
  headers: 'bare' | 'ours' | 'source'
  status: number | string
  acao: string | null
  bytes: number
}

export async function probe(url: string, referer?: string, site = 'https://example.com'): Promise<ProbeRow[]> {
  const origin = new URL(site).origin
  const sets: Record<string, Record<string, string>> = { bare: {}, ours: { origin, referer: `${origin}/` } }
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
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { referer: { type: 'string' }, site: { type: 'string', default: process.env.PROBE_SITE } },
  })
  const [url] = positionals
  if (!url) throw new Error('usage: probe.ts <url> [--referer <url>] [--site <origin>]')
  console.table(await probe(url, values.referer, values.site))
}
