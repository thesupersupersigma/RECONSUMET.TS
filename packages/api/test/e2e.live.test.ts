// Live end to end: API → streams for a real episode from each source → master playlist through the relay → media
// playlist → first two segments (decrypted if AES-128) + the subtitle, all through relay URLs.
// Default: API (PGlite) + relay in-process with the real sources. Against a running stack:
//   E2E_API_URL=http://host:port E2E_API_KEY=rk_… [E2E_ORIGIN=https://site] pnpm test:live
import { createDecipheriv } from 'node:crypto'
import { createAniList, createSources } from '@reconsumet/core'
import { connectPglite, createApiKey, migrate, pgCache } from '@reconsumet/db'
import { createRelay, loadConfig as relayConfig } from '@reconsumet/relay'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { env, SECRET } from './helpers.ts'

const ANILIST = Number(process.env.E2E_ANILIST_ID ?? 154587) // Frieren
const EPISODE = 1
const ORIGIN = process.env.E2E_ORIGIN ?? 'https://site.example'

let api: (path: string) => Promise<Response>
let relay: (url: string | URL) => Promise<Response>
let cleanup = async () => {}

beforeAll(async () => {
  const base = process.env.E2E_API_URL
  if (base) {
    const key = process.env.E2E_API_KEY ?? ''
    api = (path) => fetch(`${base}${path}`, { headers: { 'x-api-key': key } })
    relay = (url) => fetch(url, { headers: { origin: ORIGIN } })
    return
  }
  const db = await connectPglite()
  await migrate(db)
  const { fetcher, sources } = createSources()
  const app = createApp({
    config: env(),
    db,
    sources,
    anilist: createAniList({ fetcher, cache: pgCache(db, 'anilist') }),
    aniskip: null,
    remoteAddr: () => '127.0.0.1',
  })
  const r = createRelay(relayConfig({ RELAY_SECRET: SECRET, RELAY_ALLOWED_ORIGINS: ORIGIN }), {
    remoteAddress: () => '127.0.0.1',
  })
  const { key } = await createApiKey(db, 'e2e')
  api = async (path) => app.request(path, { headers: { 'x-api-key': key } })
  relay = async (url) => r.app.request(String(url), { headers: { origin: ORIGIN } })
  cleanup = async () => {
    await r.close()
    await fetcher.close()
    await db.close()
  }
})
afterAll(() => cleanup())

const isTs = (b: Uint8Array) => b[0] === 0x47 && b[188] === 0x47
const isFmp4 = (b: Uint8Array) => ['ftyp', 'styp', 'moof', 'sidx'].includes(Buffer.from(b.subarray(4, 8)).toString())
const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim())

async function ok(url: string | URL) {
  const res = await relay(url)
  expect(res.status, `${res.status} ${await res.clone().text()}`).toBeLessThan(300)
  expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  return res
}

describe.each(['reanime', 'anizone'])('%s through the relay', (source) => {
  it('streams → every server: master → media playlist → 2 segments; subtitle', async () => {
    const res = await api(`/v1/anime/${ANILIST}/episodes/${EPISODE}/streams?source=${source}`)
    const text = await res.text()
    expect(res.status, text).toBe(200)
    const body = JSON.parse(text) as {
      servers: { name: string; streams: { url: string }[]; subtitles: { url: string; format: string }[] }[]
    }
    for (const server of body.servers) await playThrough(source, server.name, server.streams[0]!.url)

    const sub = body.servers.flatMap((s) => s.subtitles)[0]
    expect(sub, 'a subtitle track').toBeDefined()
    const subText = await (await ok(sub!.url)).text()
    expect(subText.replace(/^﻿/, '')).toMatch(/^(WEBVTT|\[Script Info\]|\d+\r?\n\d\d:)/)
  })
})

/** Master → media playlist → key/init → first two segments, all through relay URLs. */
async function playThrough(source: string, serverName: string, masterUrl: string) {
  const master = await (await ok(masterUrl)).text()
  expect(master).toMatch(/^#EXTM3U/)
  for (const l of lines(master)) if (!l.startsWith('#') && l) expect(l).not.toContain('://') // relative relay URLs only
  let mediaUrl = new URL(masterUrl)
  let media = master
  if (!/#EXTINF/.test(master)) {
    const ls = lines(master)
    mediaUrl = new URL(ls[ls.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF')) + 1]!, masterUrl)
    expect(mediaUrl.origin).toBe(new URL(masterUrl).origin)
    media = await (await ok(mediaUrl)).text()
  }
  expect(media).toMatch(/#EXTINF/)

  const keyTag = media.match(/#EXT-X-KEY:METHOD=AES-128,[^\n]*?URI="([^"]+)"(?:[^\n]*?IV=0x([0-9a-f]+))?/i)
  const key = keyTag ? Buffer.from(await (await ok(new URL(keyTag[1]!, mediaUrl))).arrayBuffer()) : null
  if (key) expect(key.length).toBe(16)
  const seq = Number(media.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? 0)
  const map = media.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/)?.[1]
  if (map) expect(isFmp4(new Uint8Array(await (await ok(new URL(map, mediaUrl))).arrayBuffer()))).toBe(true)

  const segments = lines(media).filter((l) => l && !l.startsWith('#'))
  for (const [i, seg] of segments.slice(0, 2).entries()) {
    const t0 = performance.now()
    let bytes = new Uint8Array(await (await ok(new URL(seg, mediaUrl))).arrayBuffer())
    const ms = performance.now() - t0
    if (key) {
      const iv = Buffer.alloc(16)
      if (keyTag?.[2]) Buffer.from(keyTag[2].padStart(32, '0'), 'hex').copy(iv)
      else iv.writeUInt32BE(seq + i, 12)
      const d = createDecipheriv('aes-128-cbc', key, iv)
      bytes = new Uint8Array(Buffer.concat([d.update(bytes), d.final()]))
    }
    console.log(`${source} ${serverName} segment ${i}: ${bytes.length} bytes in ${ms.toFixed(0)} ms`)
    const start = Buffer.from(bytes.subarray(0, 8)).toString('hex')
    expect(isTs(bytes) || isFmp4(bytes), `segment ${i} starts ${start}`).toBe(true)
  }
}
