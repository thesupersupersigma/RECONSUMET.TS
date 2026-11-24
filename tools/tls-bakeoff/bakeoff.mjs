#!/usr/bin/env node
// bakeoff.mjs — run every TLS-impersonation candidate through the same tests and write raw JSON per machine,
// then (with --merge) one table across machines. See docs/tls-bakeoff.md for the method and results.
//
// No dependencies of its own; candidates are loaded from isolated installs under --deps. Node 22.18+ (imports the
// fetch layer's classifier straight from packages/core/src as TypeScript). Run from the RECONSUMET.TS folder.
//
//   node tools/tls-bakeoff/bakeoff.mjs --machine pc
//   node tools/tls-bakeoff/bakeoff.mjs --machine tsss-server --candidates rustyTLS-js,wreq-js --tests fingerprint,perf
//   node tools/tls-bakeoff/bakeoff.mjs --merge
//
// Politeness: every candidate sends at most one request per third-party host per run, hosts are visited one at a
// time with --delay between requests, and candidates run one after another. No logins, no challenge solving.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createSecureServer } from 'node:http2'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADAPTERS, CANDIDATES, FACTS } from './candidates.mjs'

const VERSION = '0.1.0'
const HERE = dirname(fileURLToPath(import.meta.url))
const PEET = 'https://tls.peet.ws/api/all'
// v1's TLS_IMPERSONATE_HOSTS (git show old:README.md)
const GATED_HOSTS = ['flixcloud.cc', 'overcdn.site', 'vid-cdn.xyz', 'xin-cdn.xyz', 'anidb.app', 'uwucdn.top']
const TESTS = ['fingerprint', 'gated', 'cf', 'perf', 'practical']

const HELP = `tls-bakeoff ${VERSION}

Usage: node tools/tls-bakeoff/bakeoff.mjs [options]

  --machine <name>      label for this machine's results (default: hostname)
  --candidates <list>   ${CANDIDATES.join(',')} (default: all)
  --tests <list>        ${TESTS.join(',')} (default: all)
  --deps <dir>          isolated candidate installs (default: ./out/tls-bakeoff/deps)
  --rustytls <dir>      built rustyTLS-js checkout (default: ../rustyTLS-js)
  --reference <file>    real Chrome capture of ${PEET} (default: tools/tls-bakeoff/reference/chrome.json)
  --sources <file>      source-index output; entries with check.cfChallenge are tested (default: ./out/source-index/sources.json)
  --delay <ms>          pause between third-party requests (default: 1500)
  --perf-n <n>          requests per perf phase (default: 500)
  --perf-c <n>          concurrency of the parallel perf phase (default: 32)
  --out <dir>           output folder (default: ./out/tls-bakeoff)
  --merge               don't run anything; merge <out>/*/results.json into <out>/table.md
  -q, --quiet           only print errors and the final summary
  -h, --help            show this help
  -v, --version         show version
`

function parseArgs(argv) {
  const o = {
    machine: os.hostname(),
    candidates: CANDIDATES,
    tests: TESTS,
    deps: './out/tls-bakeoff/deps',
    rustytls: '../rustyTLS-js',
    reference: join(HERE, 'reference', 'chrome.json'),
    sources: './out/source-index/sources.json',
    delay: 1500,
    perfN: 500,
    perfC: 32,
    out: './out/tls-bakeoff',
    merge: false,
    quiet: false,
    child: null,
    perfUrl: null,
  }
  const list = (v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) die(`${a} needs a value`)
      return v
    }
    switch (a) {
      case '--machine':
        o.machine = next()
        break
      case '--candidates':
        o.candidates = list(next())
        break
      case '--tests':
        o.tests = list(next())
        break
      case '--deps':
        o.deps = next()
        break
      case '--rustytls':
        o.rustytls = next()
        break
      case '--reference':
        o.reference = next()
        break
      case '--sources':
        o.sources = next()
        break
      case '--delay':
        o.delay = Math.max(0, parseInt(next(), 10) || 0)
        break
      case '--perf-n':
        o.perfN = Math.max(1, parseInt(next(), 10) || 500)
        break
      case '--perf-c':
        o.perfC = Math.max(1, parseInt(next(), 10) || 32)
        break
      case '--out':
        o.out = next()
        break
      case '--merge':
        o.merge = true
        break
      case '--child':
        o.child = next()
        break // internal
      case '--perf-url':
        o.perfUrl = next()
        break // internal
      case '-q':
      case '--quiet':
        o.quiet = true
        break
      case '-h':
      case '--help':
        process.stdout.write(HELP)
        return process.exit(0)
      case '-v':
      case '--version':
        console.log(VERSION)
        return process.exit(0)
      default:
        die(`unknown option ${a} (see --help)`)
    }
  }
  for (const c of o.candidates) if (!CANDIDATES.includes(c)) die(`unknown candidate ${c}`)
  for (const t of o.tests) if (!TESTS.includes(t)) die(`unknown test ${t}`)
  return o
}

function die(msg) {
  console.error(`tls-bakeoff: ${msg}`)
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const md5 = (s) => createHash('md5').update(s).digest('hex')
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null)
const errText = (e) => {
  const code = e?.code ?? e?.cause?.code
  const msg = String(e?.message ?? e).split('\n')[0] + (e?.cause?.message ? ` (${e.cause.message})` : '')
  return `${code ? `${code}: ` : ''}${msg}`.slice(0, 200)
}

// ---------------------------------------------------------------- fingerprint helpers

/** JA3 with the extension list sorted: Chrome shuffles extension order per connection, so raw JA3 hashes never repeat. */
function ja3n(ja3) {
  if (!ja3) return null
  const p = ja3.split(',')
  p[2] = p[2]
    .split('-')
    .map(Number)
    .sort((a, b) => a - b)
    .join('-')
  return md5(p.join(','))
}

function headerOrder(j) {
  const frame = j.http2?.sent_frames?.find((f) => f.frame_type === 'HEADERS')
  const lines = frame?.headers ?? j.http1?.headers ?? []
  return lines.map((l) => (l.startsWith(':') ? `:${l.slice(1).split(':')[0]}` : l.split(':')[0]).toLowerCase())
}

function extractFp(j) {
  return {
    httpVersion: j.http_version ?? null,
    userAgent: j.user_agent ?? null,
    ja3Hash: j.tls?.ja3_hash ?? null,
    ja3n: ja3n(j.tls?.ja3),
    ja4: j.tls?.ja4 ?? null,
    peetprintHash: j.tls?.peetprint_hash ?? null,
    akamai: j.http2?.akamai_fingerprint ?? null,
    akamaiHash: j.http2?.akamai_fingerprint_hash ?? null,
    headerOrder: headerOrder(j),
  }
}

function compareFp(fp, ref) {
  if (!ref) return null
  const same = (a, b) => a != null && a === b
  return {
    ja4: same(fp.ja4, ref.ja4),
    ja3n: same(fp.ja3n, ref.ja3n),
    akamai: same(fp.akamai, ref.akamai),
    headerOrder: fp.headerOrder.join(',') === ref.headerOrder.join(','),
    http2: fp.httpVersion === ref.httpVersion,
  }
}

// ---------------------------------------------------------------- child: runs one candidate

async function child(o) {
  const { classify } = await import(pathToFileURL(resolve(HERE, '../../packages/core/src/fetch/classify.ts')).href)
  const refRaw = readJson(o.reference)
  const result = { candidate: o.child, tests: {}, rssBeforeLoadMB: mb(process.memoryUsage().rss) }
  let a
  try {
    a = await ADAPTERS[o.child]({ depsDir: resolve(o.deps), rustyDir: resolve(o.rustytls), reference: refRaw })
    Object.assign(result, { loaded: true, version: a.version, profile: a.profile, profiles: a.profiles })
  } catch (e) {
    Object.assign(result, { loaded: false, loadError: errText(e) })
    return result
  }

  const site = async (url) => {
    const t0 = performance.now()
    try {
      const r = await a.get(url)
      const title = /<title[^>]*>([^<]{0,120})/i.exec(r.body)?.[1]?.trim() ?? null
      const cls = classify({
        status: r.status,
        headers: { get: (k) => r.headers[k.toLowerCase()] ?? null },
        body: r.body.slice(0, 16384),
      })
      return {
        url,
        status: r.status,
        finalUrl: r.url,
        class: cls,
        title,
        bytes: r.body.length,
        ms: Math.round(performance.now() - t0),
      }
    } catch (e) {
      return { url, error: errText(e), ms: Math.round(performance.now() - t0) }
    }
  }

  if (o.tests.includes('fingerprint')) {
    try {
      const r = await a.get(PEET)
      const fp = extractFp(JSON.parse(r.body))
      const ref = refRaw ? extractFp(refRaw) : null
      result.tests.fingerprint = { ...fp, match: compareFp(fp, ref) }
    } catch (e) {
      result.tests.fingerprint = { error: errText(e) }
    }
    await sleep(o.delay)
  }
  for (const [test, urls] of [
    ['gated', GATED_HOSTS.map((h) => `https://${h}/`)],
    ['cf', o.cfUrls],
  ]) {
    if (!o.tests.includes(test)) continue
    result.tests[test] = []
    for (const u of urls) {
      result.tests[test].push(await site(u))
      await sleep(o.delay)
    }
  }
  if (o.tests.includes('perf') && o.perfUrl) result.tests.perf = await perf(a, o)
  result.peakRssMB = mb(process.resourceUsage().maxRSS * 1024)
  await a.close?.()
  return result
}

const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10

async function perf(a, o) {
  const one = async () => {
    const t0 = performance.now()
    const r = await a.get(o.perfUrl, { insecure: true })
    if (r.status !== 200) throw new Error(`status ${r.status}`)
    return performance.now() - t0
  }
  const stats = (lat, ms, errors) => {
    lat.sort((x, y) => x - y)
    const q = (p) => Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] * 100) / 100
    return { n: lat.length, errors, rps: Math.round((lat.length / ms) * 1000), p50: q(0.5), p95: q(0.95) }
  }
  const out = {}
  try {
    for (let i = 0; i < 5; i++) await one() // warm-up (connection, TLS session)
    let lat = []
    let errors = 0
    let t0 = performance.now()
    for (let i = 0; i < o.perfN; i++)
      await one().then(
        (ms) => lat.push(ms),
        () => errors++,
      )
    out.sequential = stats(lat, performance.now() - t0, errors)
    lat = []
    errors = 0
    let left = o.perfN
    t0 = performance.now()
    await Promise.all(
      Array.from({ length: o.perfC }, async () => {
        while (left-- > 0)
          await one().then(
            (ms) => lat.push(ms),
            () => errors++,
          )
      }),
    )
    out.concurrent = { ...stats(lat, performance.now() - t0, errors), c: o.perfC }
  } catch (e) {
    out.error = errText(e)
  }
  return out
}

// ---------------------------------------------------------------- parent

function dirSizeMB(p) {
  if (!existsSync(p)) return null
  let total = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.isFile()) total += statSync(f).size
    }
  }
  if (statSync(p).isDirectory()) walk(p)
  else total = statSync(p).size
  return mb(total)
}

function installSize(o, c) {
  if (c === 'fetch') return 0
  if (c === 'rustyTLS-js') {
    const rust = join(o.rustytls, 'rust')
    const nodes = existsSync(rust) ? readdirSync(rust).filter((f) => f.endsWith('.node')) : []
    return mb(nodes.reduce((s, f) => s + statSync(join(rust, f)).size, 0)) + (dirSizeMB(join(o.rustytls, 'dist')) ?? 0)
  }
  if (c === 'curl-impersonate') return dirSizeMB(join(o.deps, c, process.platform === 'win32' ? 'win' : 'linux'))
  return dirSizeMB(join(o.deps, c, 'node_modules'))
}

/** Self-signed cert for the local perf server, made with the openssl CLI (once). */
function cert(o) {
  const dir = join(o.out, 'cert')
  const key = join(dir, 'key.pem')
  const crt = join(dir, 'cert.pem')
  if (!existsSync(crt)) {
    const r = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '30',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        crt,
      ],
      { stdio: 'pipe' },
    )
    if (r.status !== 0) die(`openssl failed (needed for the perf server): ${r.stderr || r.error}`)
  }
  return { key: readFileSync(key), cert: readFileSync(crt) }
}

async function startPerfServer(o) {
  await mkdir(join(o.out, 'cert'), { recursive: true })
  const body = Buffer.alloc(1024, 'x')
  const server = createSecureServer({ ...cert(o), allowHTTP1: true }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length })
    res.end(body)
  })
  await new Promise((r) => server.listen(0, r)) // all interfaces: "localhost" may resolve to ::1 or 127.0.0.1
  return { server, url: `https://localhost:${server.address().port}/` } // a name, not an IP: got-scraping refuses IP SNI
}

function runChild(o, c, tests, extraEnv, perfUrl) {
  const args = [
    fileURLToPath(import.meta.url),
    '--child',
    c,
    '--tests',
    tests.join(','),
    '--deps',
    o.deps,
    '--rustytls',
    o.rustytls,
    '--reference',
    o.reference,
    '--sources',
    o.sources,
    '--delay',
    String(o.delay),
    '--perf-n',
    String(o.perfN),
    '--perf-c',
    String(o.perfC),
  ]
  if (perfUrl) args.push('--perf-url', perfUrl)
  return new Promise((res) => {
    const p = spawn(process.execPath, args, { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => {
      out += d
    })
    p.stderr.on('data', (d) => {
      err += d
    })
    p.on('close', (code, signal) => {
      const line = out.trim().split('\n').pop()
      try {
        res(JSON.parse(line))
      } catch {
        res({
          candidate: c,
          crashed: true,
          exitCode: code,
          signal,
          stderr: err.trim().split('\n').slice(-5).join(' | ').slice(0, 400),
        })
      }
    })
  })
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.child) {
    o.cfUrls = cfUrls(o)
    const r = await child(o)
    process.stdout.write(`\n${JSON.stringify(r)}\n`)
    process.exit(0) // some candidates keep handles open
  }
  if (o.merge) return merge(o)

  const log = (...m) => o.quiet || console.log(...m)
  const dir = join(o.out, o.machine)
  await mkdir(dir, { recursive: true })
  const machine = {
    name: o.machine,
    cpu: os.cpus()[0]?.model.trim(),
    cores: os.cpus().length,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    date: new Date().toISOString(),
  }
  log(`tls-bakeoff ${VERSION} on ${machine.name} (${machine.cpu}, ${machine.platform}, node ${machine.node})`)
  if (!existsSync(o.reference))
    log(`! no reference at ${o.reference}: fingerprints are compared between candidates only`)

  const perfServer = o.tests.includes('perf') ? await startPerfServer(o) : null
  const live = o.tests.filter((t) => t !== 'perf' && t !== 'practical')
  const results = []
  for (const c of o.candidates) {
    log(`- ${c}`)
    const r = live.length ? await runChild(o, c, live, {}) : { candidate: c, tests: {} }
    if (perfServer && !r.crashed && r.loaded !== false) {
      // separate process: perf needs NODE_TLS_REJECT_UNAUTHORIZED=0 for the self-signed cert, which must not leak into live tests
      const p = await runChild(o, c, ['perf'], { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, perfServer.url)
      r.tests.perf = p.crashed
        ? { crashed: true, exitCode: p.exitCode, signal: p.signal, stderr: p.stderr }
        : p.tests.perf
      r.peakRssMB = p.peakRssMB
      r.rssBeforeLoadMB = p.rssBeforeLoadMB
      Object.assign(r, {
        loaded: p.loaded ?? r.loaded,
        version: r.version ?? p.version,
        profile: r.profile ?? p.profile,
        profiles: r.profiles ?? p.profiles,
      })
    }
    if (o.tests.includes('practical'))
      r.practical = { installMB: installSize(o, c), installed: r.loaded === true && !r.crashed, ...FACTS[c] }
    if (r.crashed) log(`  crashed: exit ${r.exitCode} ${r.signal ?? ''} ${r.stderr ?? ''}`)
    else if (r.loaded === false) log(`  failed to load: ${r.loadError}`)
    else
      log(
        `  ok${r.tests.fingerprint?.ja4 ? ` ja4=${r.tests.fingerprint.ja4}` : ''}${r.tests.perf?.sequential ? ` seq=${r.tests.perf.sequential.rps}/s` : ''}`,
      )
    results.push(r)
    await writeFile(join(dir, `${c}.json`), `${JSON.stringify(r, null, 2)}\n`)
  }
  perfServer?.server.close()
  await writeFile(join(dir, 'results.json'), `${JSON.stringify({ machine, results }, null, 2)}\n`)
  console.log(`tls-bakeoff: ${results.length} candidates on ${o.machine} -> ${join(dir, 'results.json')}`)
}

function cfUrls(o) {
  const s = readJson(o.sources)
  const list = Array.isArray(s) ? s : (s?.sources ?? [])
  return list.filter((x) => x.check?.cfChallenge).map((x) => x.url)
}

// ---------------------------------------------------------------- merge

/** Short reason for a failed request, across the candidates' different error formats. */
function errKind(text) {
  if (!text) return ''
  if (/dns|resolv|ENOTFOUND|no such host|Failed to connect|^6:/i.test(text)) return 'dead (DNS)'
  if (/redirect|^47:/i.test(text)) return 'redirect loop'
  if (/timed? ?out|^28:/i.test(text)) return 'timeout'
  return ''
}

function merge(o) {
  const machines = existsSync(o.out)
    ? readdirSync(o.out)
        .map((d) => readJson(join(o.out, d, 'results.json')))
        .filter(Boolean)
    : []
  if (!machines.length) die(`no ${o.out}/*/results.json yet`)
  const yn = (v) => (v == null ? '–' : v ? '✅' : '❌')
  const md = [
    `# TLS bake-off results\n\nGenerated ${new Date().toISOString()} by tools/tls-bakeoff/bakeoff.mjs --merge.\n`,
  ]
  for (const { machine: m, results } of machines) {
    md.push(`## ${m.name}\n\n${m.cpu} (${m.cores} threads), ${m.platform}, Node ${m.node}, run ${m.date}\n`)
    md.push('### Fingerprint vs real Chrome\n')
    md.push(
      '| candidate | version | profile | loads | HTTP | JA4 | JA3 (sorted) | Akamai H2 | header order | JA4 value |',
    )
    md.push('|---|---|---|---|---|---|---|---|---|---|')
    for (const r of results) {
      const f = r.tests?.fingerprint ?? {}
      const loads = r.crashed
        ? `💥 ${r.signal ?? `exit ${r.exitCode}`}`
        : r.loaded === false
          ? `❌ ${r.loadError}`
          : '✅'
      md.push(
        `| ${r.candidate} | ${r.version ?? ''} | ${r.profile ?? ''} | ${loads} | ${f.httpVersion ?? f.error ?? ''} | ${yn(f.match?.ja4)} | ${yn(f.match?.ja3n)} | ${yn(f.match?.akamai)} | ${yn(f.match?.headerOrder)} | \`${f.ja4 ?? ''}\` |`,
      )
    }
    for (const [test, title] of [
      ['gated', "v1's fingerprint-gated hosts"],
      ['cf', 'Cloudflare-challenge sites (from source-index)'],
    ]) {
      const rows = results.filter((r) => r.tests?.[test]?.length)
      if (!rows.length) continue
      const urls = rows[0].tests[test].map((x) => x.url)
      md.push(`\n### ${title}\n`)
      md.push(`| site | ${rows.map((r) => r.candidate).join(' | ')} |`)
      md.push(`|---|${rows.map(() => '---').join('|')}|`)
      for (const u of urls) {
        const cell = (r) => {
          const x = r.tests[test].find((y) => y.url === u)
          if (!x) return ''
          const why = errKind(x.error ?? (x.status < 200 || x.status === 421 ? x.snippet : ''))
          if (x.error || why) return why || `err ${x.error.slice(0, 30)}`
          if (x.status === 0) return 'no response (0)' // cycletls reports transport errors as status 0 / 421
          return `${x.status} ${x.class}`
        }
        md.push(`| ${new URL(u).host} | ${rows.map(cell).join(' | ')} |`)
      }
      const okCount = (r) =>
        r.tests[test].filter((x) => !x.error && x.class === 'ok' && x.status >= 200 && x.status < 400).length
      md.push(
        `| **ok (status < 400, not blocked)** | ${rows.map((r) => `**${okCount(r)}/${urls.length}**`).join(' | ')} |`,
      )
    }
    md.push('\n### Performance (local HTTPS server, 1 KiB body)\n')
    md.push(
      '| candidate | seq req/s | seq p50 ms | seq p95 ms | c32 req/s | c32 p50 ms | c32 p95 ms | errors | peak RSS MB |',
    )
    md.push('|---|---|---|---|---|---|---|---|---|')
    for (const r of results) {
      const p = r.tests?.perf
      if (!p) continue
      if (p.error || p.crashed) {
        md.push(`| ${r.candidate} | ${p.error ?? `crashed ${p.signal ?? p.exitCode}`} ||||||||`)
        continue
      }
      const s = p.sequential
      const c = p.concurrent
      md.push(
        `| ${r.candidate} | ${s.rps} | ${s.p50} | ${s.p95} | ${c.rps} | ${c.p50} | ${c.p95} | ${s.errors + c.errors} | ${r.peakRssMB} |`,
      )
    }
    md.push('\n### Practical\n')
    md.push(
      '| candidate | installed & loads | install MB | browser profiles | stream | proxy | cookies | H2 | H3 | WebSocket | license | maintenance |',
    )
    md.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const r of results) {
      const p = r.practical
      if (!p) continue
      md.push(
        `| ${r.candidate} | ${yn(p.installed)} | ${p.installMB == null ? '–' : Math.round(p.installMB * 10) / 10} | ${r.profiles ?? '–'} | ${p.stream} | ${p.proxy} | ${p.cookies} | ${p.h2} | ${p.h3} | ${p.ws} | ${p.license} | ${p.maintenance} |`,
      )
    }
    md.push('')
  }
  const file = join(o.out, 'table.md')
  return writeFile(file, `${md.join('\n')}\n`).then(() =>
    console.log(`tls-bakeoff: merged ${machines.length} machine(s) -> ${file}`),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
