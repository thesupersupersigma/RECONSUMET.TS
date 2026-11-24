#!/usr/bin/env node
// scrape-indexes.mjs — pull the anime-site directories from everythingmoe.com and theindex.moe,
// merge them by domain, and write JSON / CSV / Markdown you can sort through for v2 source candidates.
//
// No dependencies. Node 18+ (built-in fetch).
//
//   node tools/source-index/scrape-indexes.mjs                      # anime only, both sites
//   node tools/source-index/scrape-indexes.mjs --check              # + liveness check of every site
//   node tools/source-index/scrape-indexes.mjs --em-sections all --library all --include-dead
//   node tools/source-index/scrape-indexes.mjs --help
//
// Data sources (all public JSON the sites' own pages load):
//   everythingmoe.com  /data/cache/search.json  every entry + rank + section ("type"), dead sites flagged
//                      /data/cache/main.json    per-entry details (positive / negative / info / alt links)
//                      /                        HTML, only for the "filter" tags of the top-ranked entries
//   theindex.moe       /api/libraries, /api/collections, /api/columns, /api/items
//                      proAndCon columns: true -> values[0], false -> values[1] (same as theindex's own code)

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const VERSION = '0.1.0'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

// ---------------------------------------------------------------- CLI

const HELP = `scrape-indexes ${VERSION}

Usage: node scrape-indexes.mjs [options]

  --sites <list>        everythingmoe,theindex (default: both)
  --em-sections <list>  everythingmoe sections, e.g. anime,donghua,manga  or "all" (default: anime)
  --library <id>        theindex library urlId, e.g. anime, manga  or "all" (default: anime)
  --include-dead        include entries everythingmoe has marked dead
  --nsfw                include NSFW entries/sections (off by default)
  --check               HTTP-check every site's main URL (status, redirect, Cloudflare challenge)
  --concurrency <n>     parallel checks (default: 8)
  --timeout <ms>        per-request timeout (default: 15000)
  --out <dir>           output folder (default: ./out/source-index)
  --format <list>       json,csv,md (default: all three)
  -q, --quiet           only print errors and the final summary line
  -h, --help            show this help
  -v, --version         show version
`

function parseArgs(argv) {
  const o = {
    sites: ['everythingmoe', 'theindex'],
    emSections: ['anime'],
    library: 'anime',
    includeDead: false,
    nsfw: false,
    check: false,
    concurrency: 8,
    timeout: 15000,
    out: './out/source-index',
    format: ['json', 'csv', 'md'],
    quiet: false,
  }
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) die(`${a} needs a value`)
      return v
    }
    switch (a) {
      case '--sites': o.sites = list(next()); break
      case '--em-sections': o.emSections = list(next()); break
      case '--library': o.library = next(); break
      case '--include-dead': o.includeDead = true; break
      case '--nsfw': o.nsfw = true; break
      case '--check': o.check = true; break
      case '--concurrency': o.concurrency = Math.max(1, parseInt(next(), 10) || 8); break
      case '--timeout': o.timeout = Math.max(1000, parseInt(next(), 10) || 15000); break
      case '--out': o.out = next(); break
      case '--format': o.format = list(next()); break
      case '-q': case '--quiet': o.quiet = true; break
      case '-h': case '--help': process.stdout.write(HELP); process.exit(0)
      case '-v': case '--version': console.log(VERSION); process.exit(0)
      default: die(`unknown option: ${a} (see --help)`)
    }
  }
  for (const s of o.sites) if (!['everythingmoe', 'theindex'].includes(s)) die(`unknown site: ${s}`)
  for (const f of o.format) if (!['json', 'csv', 'md'].includes(f)) die(`unknown format: ${f}`)
  return o
}

function die(msg) {
  console.error(`scrape-indexes: ${msg}`)
  process.exit(2)
}

// ---------------------------------------------------------------- helpers

let opts
const log = (...a) => { if (!opts.quiet) console.error(...a) }

async function get(url, { json = true } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html' },
    signal: AbortSignal.timeout(opts.timeout),
  })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return json ? res.json() : res.text()
}

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

const splitHash = (s) => (s ? String(s).split('#').map((x) => x.trim()).filter(Boolean) : [])

// "label<<url#label<<url" -> [{label, url}]
function parseAltLinks(s) {
  return splitHash(s).map((part) => {
    const i = part.indexOf('<<')
    return i === -1 ? { label: '', url: part } : { label: part.slice(0, i).trim(), url: part.slice(i + 2).trim() }
  })
}

const stripHtml = (s) => String(s ?? '').replace(/<[^>]+>/g, '').trim()

const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")

// ---------------------------------------------------------------- everythingmoe

const EM = 'https://everythingmoe.com'
const EM_NSFW_SECTIONS = new Set(['hentai', 'hentairead'])

async function scrapeEverythingMoe() {
  log('everythingmoe: fetching search.json, main.json, index page…')
  const [search, main, html] = await Promise.all([
    get(`${EM}/data/cache/search.json`),
    get(`${EM}/data/cache/main.json`),
    get(`${EM}/`, { json: false }),
  ])

  // filter tags: top-ranked entries carry them in the HTML, the rest in main.json "section<name>" lists
  const filters = new Map()
  for (const m of html.matchAll(/<div\b([^>]*\bclass="section-item[^"]*"[^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = m[1]
    const filter = /data-filter="([^"]*)"/.exec(attrs)?.[1]
    const slug = /href="\/s\/([^"]+)"/.exec(m[2])?.[1]
    if (slug && filter) filters.set(slug, filter)
  }
  for (const [key, val] of Object.entries(main)) {
    if (!key.startsWith('section') || !Array.isArray(val)) continue
    for (const e of val) if (e?.id && e.filter && !filters.has(e.id)) filters.set(e.id, e.filter)
  }

  const wantAll = opts.emSections.includes('all')
  const out = []
  for (const e of search) {
    if (!e.id || !e.link) continue // jump-menu rows
    const dead = Boolean(e.DEAD) || e.type === 'dead'
    if (dead && !opts.includeDead) continue
    const tags = [e.tags, e.hiddentags].filter(Boolean).join(' ').split(/\s+/).filter(Boolean)
    const section = dead ? 'dead' : e.type
    const nsfw = tags.includes('nsfw') || EM_NSFW_SECTIONS.has(section)
    if (nsfw && !opts.nsfw) continue
    // dead entries lost their section; keep them when --include-dead and the section filter is "all",
    // or when their keywords mention one of the wanted sections
    if (!wantAll && !dead && !opts.emSections.includes(section)) continue
    if (!wantAll && dead && !opts.emSections.some((s) => (e.keys ?? '').includes(s))) continue

    const d = main[e.id] && !Array.isArray(main[e.id]) ? main[e.id] : {}
    const rankNum = parseInt(String(e.rank), 10)
    out.push({
      source: 'everythingmoe',
      id: e.id,
      name: decodeEntities(e.title),
      url: e.link,
      domain: domainOf(e.link),
      section,
      rank: Number.isFinite(rankNum) ? rankNum : null,
      dead,
      tags,
      filters: (filters.get(e.id) ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      positive: splitHash(d.positive),
      negative: splitHash(d.negative),
      info: stripHtml(d.info),
      altLinks: [...parseAltLinks(d.altlink), ...parseAltLinks(d['ex-altlink']), ...parseAltLinks(d['exx-altlink'])],
      extraDomains: splitHash(d.domains ?? d.domain),
      page: `${EM}/s/${e.id}`,
    })
  }
  out.sort((a, b) => (a.section < b.section ? -1 : a.section > b.section ? 1 : (a.rank ?? 1e9) - (b.rank ?? 1e9)))
  log(`everythingmoe: ${out.length} entries`)
  return out
}

// ---------------------------------------------------------------- theindex

const TI = 'https://theindex.moe'

function formatColumn(col, value) {
  if (value === undefined || value === null) return null
  switch (col.type) {
    case 'proAndCon':
      return typeof value === 'boolean' ? col.values?.[value ? 0 : 1] ?? String(value) : String(value)
    case 'feature':
      return value === true ? 'yes' : value === false ? 'no' : String(value)
    default:
      return Array.isArray(value) ? value.join(', ') : String(value)
  }
}

async function scrapeTheIndex() {
  log('theindex: fetching libraries, collections, columns, items…')
  const [libraries, collections, columns, items] = await Promise.all([
    get(`${TI}/api/libraries`),
    get(`${TI}/api/collections`),
    get(`${TI}/api/columns`),
    get(`${TI}/api/items`),
  ])
  const colById = new Map(columns.map((c) => [c._id, c]))
  const collById = new Map(collections.map((c) => [c._id, c]))

  const libs = opts.library === 'all' ? libraries : libraries.filter((l) => l.urlId === opts.library)
  if (libs.length === 0) die(`theindex has no library "${opts.library}" (have: ${libraries.map((l) => l.urlId).join(', ')})`)

  // item id -> [{library, collection}]
  const membership = new Map()
  for (const lib of libs) {
    if (lib.nsfw && !opts.nsfw) continue
    for (const cid of lib.collections ?? []) {
      const coll = collById.get(cid)
      if (!coll || (coll.nsfw && !opts.nsfw)) continue
      for (const iid of coll.items ?? []) {
        if (!membership.has(iid)) membership.set(iid, [])
        membership.get(iid).push({ library: lib.urlId, collection: coll.name })
      }
    }
  }

  const out = []
  for (const it of items) {
    const where = membership.get(it._id)
    if (!where) continue
    if (it.nsfw && !opts.nsfw) continue
    const fields = {}
    for (const [cid, val] of Object.entries(it.data ?? {})) {
      const col = colById.get(cid)
      if (!col) continue
      const f = formatColumn(col, val)
      if (f !== null && f !== '') fields[col.urlId] = f
    }
    const url = it.urls?.[0] ?? null
    out.push({
      source: 'theindex',
      id: it._id,
      name: it.name,
      url,
      domain: url ? domainOf(url) : null,
      urls: it.urls ?? [],
      libraries: [...new Set(where.map((w) => w.library))],
      collections: [...new Set(where.map((w) => w.collection))],
      blacklist: Boolean(it.blacklist),
      sponsor: Boolean(it.sponsor),
      description: it.description ?? '',
      fields,
      page: `${TI}/item/${it._id}`,
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  log(`theindex: ${out.length} entries`)
  return out
}

// ---------------------------------------------------------------- merge

function merge(em, ti) {
  const byDomain = new Map()
  const add = (domain, rec) => {
    const key = domain ?? `nodomain:${rec.source}:${rec.id}`
    if (!byDomain.has(key)) byDomain.set(key, { domain, names: new Set(), everythingmoe: null, theindex: null })
    const m = byDomain.get(key)
    m.names.add(rec.name)
    m[rec.source] = rec
    return m
  }
  // everythingmoe lists mirrors/old domains as alt links: index those too, so a theindex entry
  // that uses a mirror domain still lands on the same site
  const alias = new Map()
  for (const r of em) {
    const m = add(r.domain, r)
    for (const l of r.altLinks ?? []) {
      const d = domainOf(l.url)
      if (d && d !== r.domain && !alias.has(d)) alias.set(d, m)
    }
  }
  for (const r of ti) {
    // theindex items can list several urls: attach to an existing everythingmoe site if any of them match
    const doms = (r.urls ?? []).map(domainOf).filter(Boolean)
    const direct = doms.find((d) => byDomain.has(d) && !byDomain.get(d).theindex)
    const viaAlias = !direct && doms.map((d) => alias.get(d)).find((m) => m && !m.theindex)
    if (viaAlias) {
      viaAlias.names.add(r.name)
      viaAlias.theindex = r
    } else add(direct ?? r.domain, r)
  }
  return [...new Set(byDomain.values())]
    .map((m) => ({
      name: [...m.names][0],
      otherNames: [...m.names].slice(1),
      domain: m.domain,
      url: m.everythingmoe?.url ?? m.theindex?.url ?? null,
      onBoth: Boolean(m.everythingmoe && m.theindex),
      emRank: m.everythingmoe?.rank ?? null,
      emSection: m.everythingmoe?.section ?? null,
      dead: m.everythingmoe?.dead ?? false,
      blacklisted: m.theindex?.blacklist ?? false,
      softSub:
        (m.everythingmoe?.filters ?? []).includes('Soft-sub') ||
        /soft/i.test((m.everythingmoe?.positive ?? []).join(' ')) ||
        null,
      selfHosted: (m.everythingmoe?.filters ?? []).includes('Self-host') || null,
      everythingmoe: m.everythingmoe,
      theindex: m.theindex,
      check: null,
    }))
    .sort((a, b) => (a.emRank ?? 1e9) - (b.emRank ?? 1e9) || a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------- liveness check

async function checkOne(url) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(opts.timeout),
    })
    const body = await res.text().catch(() => '')
    const server = res.headers.get('server') ?? ''
    const cfChallenge =
      res.headers.get('cf-mitigated') === 'challenge' ||
      (/cloudflare/i.test(server) && [403, 503].includes(res.status) && /just a moment|challenge-platform/i.test(body))
    return {
      status: res.status,
      ok: res.ok,
      finalUrl: res.url,
      redirectedDomain: domainOf(res.url) !== domainOf(url) ? domainOf(res.url) : null,
      cloudflare: /cloudflare/i.test(server),
      cfChallenge,
      ms: Date.now() - started,
      error: null,
    }
  } catch (err) {
    return { status: null, ok: false, finalUrl: null, redirectedDomain: null, cloudflare: false, cfChallenge: false, ms: Date.now() - started, error: err?.cause?.code ?? err?.name ?? String(err) }
  }
}

async function checkAll(rows) {
  const todo = rows.filter((r) => r.url)
  let i = 0
  let done = 0
  const worker = async () => {
    while (i < todo.length) {
      const r = todo[i++]
      r.check = await checkOne(r.url)
      done++
      if (!opts.quiet && (done % 10 === 0 || done === todo.length)) process.stderr.write(`\rchecking… ${done}/${todo.length}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, todo.length) }, worker))
  if (!opts.quiet) process.stderr.write('\n')
}

function checkLabel(c) {
  if (!c) return ''
  if (c.error) return `down (${c.error})`
  if (c.cfChallenge) return `CF challenge (${c.status})`
  if (c.redirectedDomain) return `${c.status} -> ${c.redirectedDomain}`
  return String(c.status)
}

// ---------------------------------------------------------------- output

function csvCell(v) {
  const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows) {
  const head = ['name', 'domain', 'url', 'on_both', 'em_section', 'em_rank', 'dead', 'blacklisted', 'soft_sub', 'self_hosted',
    'em_filters', 'em_positive', 'em_negative', 'em_info', 'ti_collections', 'ti_subs', 'ti_dubs', 'ti_quality', 'ti_ads',
    'alt_domains', 'check', 'em_page', 'ti_page']
  const lines = [head.join(',')]
  for (const r of rows) {
    const em = r.everythingmoe
    const ti = r.theindex
    lines.push([
      r.name, r.domain, r.url, r.onBoth, r.emSection, r.emRank, r.dead, r.blacklisted, r.softSub, r.selfHosted,
      em?.filters, em?.positive, em?.negative, em?.info, ti?.collections, ti?.fields?.subs, ti?.fields?.dubs,
      ti?.fields?.['2160p'], ti?.fields?.ads,
      [...new Set((em?.altLinks ?? []).map((l) => domainOf(l.url)).filter(Boolean))],
      checkLabel(r.check), em?.page, ti?.page,
    ].map(csvCell).join(','))
  }
  return lines.join('\n') + '\n'
}

const mdCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

function toMarkdown(rows, meta) {
  const L = []
  L.push(`# Anime source index — ${meta.generatedAt.slice(0, 10)}`, '')
  L.push(`Generated by \`scrape-indexes.mjs\` ${VERSION}. everythingmoe sections: \`${opts.emSections.join(',')}\`; theindex library: \`${opts.library}\`.`, '')
  L.push(`- everythingmoe entries: **${meta.counts.everythingmoe}**`)
  L.push(`- theindex entries: **${meta.counts.theindex}**`)
  L.push(`- merged sites: **${rows.length}**, listed on both: **${rows.filter((r) => r.onBoth).length}**`)
  if (opts.check) {
    const up = rows.filter((r) => r.check?.ok && !r.check.cfChallenge).length
    const cf = rows.filter((r) => r.check?.cfChallenge).length
    const down = rows.filter((r) => r.check && !r.check.ok && !r.check.cfChallenge).length
    L.push(`- check: **${up}** up, **${cf}** behind a Cloudflare challenge, **${down}** down/erroring`)
  }
  L.push('', '| # | Site | Domain | EM rank | Both | Soft-sub | Self-host | Subs (theindex) | Check | Notes |', '|---|---|---|---|---|---|---|---|---|---|')
  rows.forEach((r, i) => {
    const notes = [
      r.dead ? 'DEAD (everythingmoe)' : '',
      r.blacklisted ? 'blacklisted (theindex)' : '',
      ...(r.everythingmoe?.negative ?? []).slice(0, 2).map((n) => `− ${n}`),
    ].filter(Boolean).join('; ')
    L.push(`| ${i + 1} | ${mdCell(r.name)} | ${mdCell(r.domain)} | ${r.emRank ?? ''} | ${r.onBoth ? 'yes' : ''} | ${r.softSub ? 'yes' : ''} | ${r.selfHosted ? 'yes' : ''} | ${mdCell(r.theindex?.fields?.subs ?? '')} | ${mdCell(checkLabel(r.check))} | ${mdCell(notes)} |`)
  })
  return L.join('\n') + '\n'
}

// ---------------------------------------------------------------- main

async function main() {
  opts = parseArgs(process.argv.slice(2))
  const [em, ti] = await Promise.all([
    opts.sites.includes('everythingmoe') ? scrapeEverythingMoe() : [],
    opts.sites.includes('theindex') ? scrapeTheIndex() : [],
  ])
  const rows = merge(em, ti)
  if (opts.check) await checkAll(rows)

  const meta = {
    generatedAt: new Date().toISOString(),
    tool: `scrape-indexes ${VERSION}`,
    options: opts,
    counts: { everythingmoe: em.length, theindex: ti.length, merged: rows.length, onBoth: rows.filter((r) => r.onBoth).length },
  }
  const dir = resolve(opts.out)
  await mkdir(dir, { recursive: true })
  const written = []
  if (opts.format.includes('json')) {
    await writeFile(join(dir, 'everythingmoe.json'), JSON.stringify(em, null, 2))
    await writeFile(join(dir, 'theindex.json'), JSON.stringify(ti, null, 2))
    await writeFile(join(dir, 'sources.json'), JSON.stringify({ meta, sources: rows }, null, 2))
    written.push('everythingmoe.json', 'theindex.json', 'sources.json')
  }
  if (opts.format.includes('csv')) {
    await writeFile(join(dir, 'sources.csv'), toCsv(rows))
    written.push('sources.csv')
  }
  if (opts.format.includes('md')) {
    await writeFile(join(dir, 'sources.md'), toMarkdown(rows, meta))
    written.push('sources.md')
  }
  console.log(`scrape-indexes: ${rows.length} sites (${meta.counts.onBoth} on both indexes) -> ${dir} [${written.join(', ')}]`)
}

main().catch((err) => {
  console.error(`scrape-indexes: ${err?.stack ?? err}`)
  process.exit(1)
})
