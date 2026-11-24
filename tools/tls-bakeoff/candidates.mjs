// One adapter per bake-off candidate. Each `create()` returns
//   { version, profile, profiles, get(url, { insecure }) -> { status, url, headers, body, httpVersion }, close() }
// Libraries are loaded from their isolated install folders (see bakeoff.mjs --deps), never from the repo.

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'

// Static facts (from each project's README / API / npm metadata, checked 2026-11-23). Measured facts live in the results.
export const FACTS = {
  'rustyTLS-js': {
    engine: 'Rust wreq + BoringSSL (our fork), in-process',
    stream: 'yes',
    proxy: 'http/https/socks',
    cookies: 'yes (session jar)',
    h2: 'yes',
    h3: 'no',
    ws: 'yes',
    license: 'MIT (wreq: Apache-2.0)',
    maintenance: 'ours; upstream very active',
  },
  'wreq-js': {
    engine: 'Rust wreq + BoringSSL, in-process (npm prebuilt)',
    stream: 'yes',
    proxy: 'http/https/socks',
    cookies: 'yes (session jar)',
    h2: 'yes',
    h3: 'no',
    ws: 'yes',
    license: 'MIT (wreq: Apache-2.0)',
    maintenance: 'very active (renovate, frequent releases)',
  },
  impit: {
    engine: 'Rust reqwest + patched rustls, in-process',
    stream: 'yes (fetch Response.body)',
    proxy: 'http/https/socks',
    cookies: 'yes (tough-cookie compatible jar)',
    h2: 'yes',
    h3: 'yes (opt-in)',
    ws: 'no',
    license: 'Apache-2.0',
    maintenance: 'active (Apify)',
  },
  impers: {
    engine: 'libcurl-impersonate via koffi FFI, in-process',
    stream: 'yes',
    proxy: 'http/https/socks',
    cookies: 'yes',
    h2: 'yes',
    h3: 'yes',
    ws: 'yes',
    license: 'MIT (curl-impersonate: MIT)',
    maintenance: 'active, alpha (0.1.x)',
  },
  cycletls: {
    engine: 'Go utls subprocess + IPC',
    stream: 'yes (responseType stream)',
    proxy: 'http/socks',
    cookies: 'manual',
    h2: 'yes',
    h3: 'yes (forceHTTP3)',
    ws: 'yes',
    license: 'GPL-3.0',
    maintenance: 'slow (last npm release 2025-10)',
  },
  'got-scraping': {
    engine: 'got + header-generator (pure JS, Node TLS)',
    stream: 'yes',
    proxy: 'http/https',
    cookies: 'yes (tough-cookie)',
    h2: 'yes',
    h3: 'no',
    ws: 'no',
    license: 'Apache-2.0',
    maintenance: 'end of life per Apify',
  },
  'curl-impersonate': {
    engine: 'curl-impersonate CLI, one process per request',
    stream: 'yes (stdout)',
    proxy: 'all curl proxies',
    cookies: 'cookie file',
    h2: 'yes',
    h3: 'yes',
    ws: 'yes (curl ws)',
    license: 'MIT',
    maintenance: 'active (lexiforest)',
  },
  fetch: {
    engine: 'Node built-in fetch (undici), no impersonation',
    stream: 'yes',
    proxy: 'via undici ProxyAgent',
    cookies: 'no',
    h2: 'yes (Node 26 / undici 8 offers h2)',
    h3: 'no',
    ws: 'yes (WebSocket global)',
    license: 'MIT',
    maintenance: 'Node core',
  },
}

export const CANDIDATES = Object.keys(FACTS)

/** Import a package's ESM/CJS entry from <deps>/<folder>/node_modules/<pkg>. */
async function load(depsDir, folder, pkg) {
  const dir = join(depsDir, folder, 'node_modules', pkg)
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const pick = (x) => (typeof x === 'string' ? x : x && (pick(x.import) || pick(x.node) || pick(x.default)))
  const exp = pj.exports && typeof pj.exports === 'object' && '.' in pj.exports ? pj.exports['.'] : pj.exports
  const mod = await import(pathToFileURL(join(dir, pick(exp) || pj.main || 'index.js')).href)
  return { mod: mod.default && Object.keys(mod).length <= 2 ? { ...mod.default, ...mod } : mod, version: pj.version }
}

const lowerHeaders = (h) => {
  const o = {}
  if (typeof h?.forEach === 'function')
    h.forEach((v, k) => {
      o[k.toLowerCase()] = v
    })
  else for (const [k, v] of Object.entries(h ?? {})) o[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
  return o
}

async function wreqLike(mod, version) {
  const profile = mod.resolveProfile ? mod.resolveProfile('chrome') : 'chrome'
  // a session keeps the pool + TLS session cache (standalone fetch() handshakes every call, per its README)
  const sessions = new Map()
  const session = async (insecure) => {
    if (!sessions.has(insecure))
      sessions.set(insecure, await mod.createSession({ browser: profile, os: 'windows', insecure, timeout: 20000 }))
    return sessions.get(insecure)
  }
  return {
    version,
    profile,
    profiles: mod.getProfiles?.().length ?? null,
    async get(url, { insecure } = {}) {
      const r = await (await session(!!insecure)).fetch(url)
      return {
        status: r.status,
        url: r.url,
        headers: lowerHeaders(r.headers),
        body: await r.text(),
        httpVersion: r.httpVersion ?? null,
      }
    },
    close: () => Promise.all([...sessions.values()].map((x) => x.close())),
  }
}

export const ADAPTERS = {
  async 'rustyTLS-js'({ rustyDir }) {
    const entry = join(rustyDir, 'dist', 'wreq-js.js')
    if (!existsSync(entry)) throw new Error(`not built: ${entry} (run npm run build in rustyTLS-js)`)
    const mod = await import(pathToFileURL(entry).href)
    const version = JSON.parse(readFileSync(join(rustyDir, 'package.json'), 'utf8')).version
    return wreqLike(mod, `${version} (local fork build)`)
  },

  async 'wreq-js'({ depsDir }) {
    const { mod, version } = await load(depsDir, 'wreq-js', 'wreq-js')
    return wreqLike(mod, version)
  },

  async impit({ depsDir }) {
    const { mod, version } = await load(depsDir, 'impit', 'impit')
    const clients = new Map()
    const client = (insecure) => {
      if (!clients.has(insecure))
        clients.set(insecure, new mod.Impit({ browser: 'chrome', ignoreTlsErrors: !!insecure, timeout: 20000 }))
      return clients.get(insecure)
    }
    return {
      version,
      profile: 'chrome (newest alias)',
      profiles: 24, // Browser union in index.d.ts incl. aliases
      async get(url, { insecure } = {}) {
        const r = await client(insecure).fetch(url)
        return {
          status: r.status,
          url: r.url,
          headers: lowerHeaders(r.headers),
          body: await r.text(),
          httpVersion: null,
        }
      },
      close() {},
    }
  },

  async impers({ depsDir }) {
    const { mod, version } = await load(depsDir, 'impers', 'impers')
    const fps = await import(
      pathToFileURL(join(depsDir, 'impers', 'node_modules', 'impers', 'dist', 'fingerprints.js')).href
    )
    return {
      version,
      profile: 'chrome (newest alias)',
      profiles: fps.NATIVE_IMPERSONATE_TARGETS?.length ?? null,
      async get(url, { insecure } = {}) {
        const r = await mod.get(url, { impersonate: 'chrome', verify: !insecure, timeout: 20 })
        return {
          status: r.statusCode,
          url: r.url,
          headers: lowerHeaders(r.headers),
          body: r.text,
          httpVersion: r.httpVersion,
        }
      },
      close: () => mod.closeSharedSession?.(),
    }
  },

  async cycletls({ depsDir, reference }) {
    const { mod, version } = await load(depsDir, 'cycletls', 'cycletls')
    const init = typeof mod === 'function' ? mod : (mod.default ?? mod.initCycleTLS)
    const client = await init()
    // CycleTLS has no browser presets: it is configured with fingerprint strings, here copied from the reference.
    const fp = reference
      ? {
          ja3: reference.tls.ja3,
          ja4r: reference.tls.ja4_r,
          http2Fingerprint: reference.http2.akamai_fingerprint,
          userAgent: reference.user_agent,
        }
      : { userAgent: CHROME_UA }
    return {
      version,
      profile: reference ? 'manual: reference JA3 + JA4_r + Akamai' : 'manual: UA only (no reference)',
      profiles: 0,
      async get(url, { insecure } = {}) {
        const r = await client(url, { ...fp, timeout: 20, insecureSkipVerify: !!insecure }, 'get')
        return {
          status: r.status,
          url: r.finalUrl || url,
          headers: lowerHeaders(r.headers),
          body: await r.text(),
          httpVersion: null,
        }
      },
      close: () => client.exit(),
    }
  },

  async 'got-scraping'({ depsDir }) {
    const { mod, version } = await load(depsDir, 'got-scraping', 'got-scraping')
    return {
      version,
      profile: 'header-generator chrome/windows',
      profiles: 0,
      async get(url, { insecure } = {}) {
        const r = await mod.gotScraping({
          url,
          headerGeneratorOptions: { browsers: [{ name: 'chrome' }], operatingSystems: ['windows'] },
          https: { rejectUnauthorized: !insecure },
          throwHttpErrors: false,
          timeout: { request: 20000 },
        })
        return {
          status: r.statusCode,
          url: r.url,
          headers: lowerHeaders(r.headers),
          body: r.body,
          httpVersion: r.httpVersion,
        }
      },
      close() {},
    }
  },

  async 'curl-impersonate'({ depsDir }) {
    const base = join(depsDir, 'curl-impersonate', process.platform === 'win32' ? 'win' : 'linux')
    const bin = join(base, process.platform === 'win32' ? 'curl-impersonate.exe' : 'curl-impersonate')
    if (!existsSync(bin)) throw new Error(`missing ${bin}`)
    const targets = readdirSync(base)
      .map((f) => /^curl_(chrome\d+)(\.bat)?$/.exec(f)?.[1])
      .filter(Boolean)
    const target = targets.sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)))[0]
    const all = readdirSync(base).filter((f) => /^curl_[a-z]/.test(f)).length
    const run = (args) =>
      new Promise((res, rej) =>
        execFile(bin, args, { encoding: 'latin1', maxBuffer: 64 << 20, windowsHide: true }, (e, out) =>
          e ? rej(e) : res(out),
        ),
      )
    // Linux builds report "curl-impersonate/local"; the release tag is in the downloaded tarball's name
    const tarball = readdirSync(join(depsDir, 'curl-impersonate')).find((f) => /^curl-impersonate-v[\d.]+\./.test(f))
    const version =
      tarball?.match(/-(v\d+\.\d+\.\d+)\./)?.[1] ??
      (await run(['--version'])).match(/curl-impersonate\/(\S+)/)?.[1] ??
      '?'
    return {
      version,
      profile: target,
      profiles: all,
      async get(url, { insecure } = {}) {
        const marker = '\n@@CURL@@'
        const args = [
          '--compressed',
          '--impersonate',
          target,
          '-s',
          '-L',
          '--max-time',
          '20',
          '-D',
          '-',
          '-w',
          `${marker}%{http_code} %{url_effective} %{http_version}`,
          url,
        ]
        if (insecure) args.unshift('-k')
        const out = Buffer.from(await run(args), 'latin1').toString('utf8')
        const i = out.lastIndexOf(marker)
        const [code, eff, ver] = out
          .slice(i + marker.length)
          .trim()
          .split(' ')
        let rest = out.slice(0, i)
        let headers = {}
        // -D - with -L prints every hop's header block; keep the last one
        for (;;) {
          const m = /^HTTP\/[\d.]+ \d+[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n/.exec(rest)
          if (!m) break
          headers = Object.fromEntries(
            m[1]
              .split(/\r?\n/)
              .map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]),
          )
          rest = rest.slice(m[0].length)
        }
        return { status: Number(code), url: eff, headers, body: rest, httpVersion: ver }
      },
      close() {},
    }
  },

  async fetch() {
    return {
      version: process.versions.undici ?? process.version,
      profile: 'none (Chrome User-Agent header only)',
      profiles: 0,
      async get(url) {
        const r = await fetch(url, { headers: { 'user-agent': CHROME_UA }, signal: AbortSignal.timeout(20000) })
        return {
          status: r.status,
          url: r.url,
          headers: lowerHeaders(r.headers),
          body: await r.text(),
          httpVersion: null,
        }
      },
      close() {},
    }
  },
}
