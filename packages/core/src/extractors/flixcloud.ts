// FlixCloud (flixcloud.cc) — the video host behind Re:Anime ("HD-1" = ?v=1, "HD-2" = ?v=2).
//
// The embed is a SvelteKit page whose inline `data` hides the stream (unchanged since v1, re-verified 2026-11-24):
//  1. field names derive from `obfuscation_seed` via chained SHA-256 (the page is full of decoy fields)
//  2. GET /api/m3u8/<tokenRef> returns a map keyed by sha256(tokenRef+"vid")[:10] (AES ciphertext of the playlist
//     URL) and sha256(tokenRef+"key")[:10] (third key fragment)
//  3. the page's own tiny WASM (`w_payload`, exports _s/_r/_c) mixes the three 32-byte fragments → E; _c() → the
//     playlist XOR key
//  4. key = sha256(PBKDF2(E, seed, 1000, sha256, 32) XOR seed); AES-256-CBC(iv = ivf_* field) → master.m3u8 URL
// Playlists are base64 + XOR(playlist key); segments sit on other hosts (vertexcdn.site, rundowncdn.top, …) and
// need FlixCloud's Referer. HD-1 URLs carry a JWT with the requester's IP (`client_ip`).
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import type { Fetcher } from '../fetch/index.ts'
import type { Server, Subtitle } from '../sources/types.ts'

export const FLIXCLOUD_ORIGIN = 'https://flixcloud.cc'
/** What every FlixCloud playlist, key and segment request must carry (segment hosts 403 without it). */
export const FLIXCLOUD_HEADERS = { referer: `${FLIXCLOUD_ORIGIN}/`, origin: FLIXCLOUD_ORIGIN }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export interface FlixEmbed {
  seed: string
  wasm: string
  keyFrag1: string
  keyFrag2: string
  iv: string
  tokenRef: string
  subtitles: Subtitle[]
  intro?: { start: number; end: number }
  outro?: { start: number; end: number }
}

export function deriveFieldNames(seed: string) {
  let e = seed
  for (let i = 0; i < 3; i++) e = sha256(e + i)
  let s = e
  for (let i = 0; i < 3; i++) s = sha256(s + i)
  return {
    keyFrag1: `kf_${e.slice(8, 16)}`,
    iv: `ivf_${e.slice(16, 24)}`,
    tokenRef: `${e.slice(48, 64)}_${e.slice(56, 64)}`,
    keyFrag2: `${s.slice(0, 16)}_${s.slice(16, 24)}`,
  }
}

/** Value of `name:"…"` / `"name":"…"` in the page's JS object literal. */
function field(html: string, name: string): string | undefined {
  return html.match(new RegExp(`[{,]"?${name}"?:"([^"]*)"`))?.[1]
}

function chapter(html: string, name: string) {
  const m = html.match(new RegExp(`${name}:\\{start:(\\d+(?:\\.\\d+)?),end:(\\d+(?:\\.\\d+)?)`))
  return m ? { start: Number(m[1]), end: Number(m[2]) } : undefined
}

const LANGS: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  portuguese: 'pt',
  french: 'fr',
  german: 'de',
  italian: 'it',
  arabic: 'ar',
  russian: 'ru',
  japanese: 'ja',
}

export function parseEmbed(html: string): FlixEmbed {
  const seed = html.match(/obfuscation_seed:"([0-9a-f]+)"/)?.[1]
  const wasm = html.match(/w_payload:"([A-Za-z0-9+/=]+)"/)?.[1]
  if (!seed || !wasm) throw new Error('flixcloud: embed has no obfuscation_seed / w_payload (page changed?)')
  const names = deriveFieldNames(seed)
  const values = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, field(html, n)]))
  for (const [k, v] of Object.entries(values))
    if (!v) throw new Error(`flixcloud: field ${k} not found (scheme changed?)`)

  const subtitles: Subtitle[] = []
  for (const m of html.matchAll(/\{url:"([^"]+)",language:"([^"]*)",format:"(\w+)",default:(true|false)\}/g)) {
    const [, url, label = '', format] = m as unknown as string[]
    if (format !== 'ass' && format !== 'vtt' && format !== 'srt') continue
    const lang = LANGS[label.split(/[\s(]/)[0]?.toLowerCase() ?? ''] ?? 'und'
    subtitles.push({ url: url as string, label, lang, format, default: m[4] === 'true' })
  }
  return {
    seed,
    wasm,
    ...(values as Pick<FlixEmbed, 'keyFrag1' | 'keyFrag2' | 'iv' | 'tokenRef'>),
    subtitles,
    intro: chapter(html, 'intro_chapter'),
    outro: chapter(html, 'outro_chapter'),
  }
}

// The tsconfig has no DOM lib, so declare the bit of the global WebAssembly API we use.
const wasmApi = (
  globalThis as unknown as {
    WebAssembly: { instantiate(bytes: Uint8Array, imports: object): Promise<{ instance: { exports: unknown } }> }
  }
).WebAssembly

/** Run the page's WASM: three 32-byte fragments → E, plus the playlist XOR key from _c(). */
export async function runWasm(embed: FlixEmbed, keyFrag3: string): Promise<{ e: Buffer; playlistKey: Buffer }> {
  const { instance } = await wasmApi.instantiate(Buffer.from(embed.wasm, 'base64'), {})
  const x = instance.exports as {
    memory: { buffer: ArrayBuffer; grow(pages: number): number }
    _s(seed: number): void
    _r(a: number, b: number, c: number, out: number, len: number): void
    _c(): number
  }
  if (x.memory.buffer.byteLength === 0) x.memory.grow(1)
  const frags = [embed.keyFrag1, embed.keyFrag2, keyFrag3].map((b) => Buffer.from(b, 'base64'))
  const k = frags[0]?.length ?? 0
  if (k === 0 || frags.some((f) => f.length !== k)) throw new Error('flixcloud: key fragments have unequal lengths')
  const at = 1000 // the site's own JS uses this offset
  const view = new Uint8Array(x.memory.buffer)
  frags.forEach((f, i) => {
    view.set(f, at + i * k)
  })
  x._s(Number.parseInt(embed.seed.slice(0, 8), 16))
  x._r(at, at + k, at + 2 * k, at + 3 * k, k)
  const e = Buffer.from(new Uint8Array(x.memory.buffer).slice(at + 3 * k, at + 4 * k))
  const p = x._c()
  return { e, playlistKey: Buffer.from(new Uint8Array(x.memory.buffer).slice(p, p + 32)) }
}

export function aesKey(e: Buffer, seed: string): Buffer {
  const d = pbkdf2Sync(e, Buffer.from(seed, 'utf8'), 1000, 32, 'sha256')
  for (let i = 0; i < d.length; i++) d[i] = (d[i] as number) ^ seed.charCodeAt(i % seed.length)
  return createHash('sha256').update(d).digest()
}

export function tokenKeys(tokenRef: string) {
  return { cipher: sha256(`${tokenRef}vid`).slice(0, 10), keyFrag3: sha256(`${tokenRef}key`).slice(0, 10) }
}

/** Embed page + token response → the master playlist URL and its playlist key. */
export async function decryptStream(embed: FlixEmbed, token: Record<string, unknown>) {
  const names = tokenKeys(embed.tokenRef)
  const cipher = token[names.cipher]
  const keyFrag3 = token[names.keyFrag3]
  if (typeof cipher !== 'string' || typeof keyFrag3 !== 'string') throw new Error('flixcloud: token response changed')
  const { e, playlistKey } = await runWasm(embed, keyFrag3)
  const d = createDecipheriv('aes-256-cbc', aesKey(e, embed.seed), Buffer.from(embed.iv, 'base64'))
  const url = Buffer.concat([d.update(Buffer.from(cipher, 'base64')), d.final()])
    .toString('utf8')
    .trim()
  if (!/^https:\/\/[^\s/]+\/\S+\.m3u8(\?\S*)?$/.test(url))
    throw new Error('flixcloud: decrypted value is not a playlist URL')
  return { url, playlistKey: playlistKey.toString('base64') }
}

/** Decode one FlixCloud playlist body (base64 + XOR). Bodies that are already plain pass through. */
export function decodePlaylist(body: string, playlistKey: string): string {
  if (body.trimStart().startsWith('#EXTM3U')) return body
  const key = Buffer.from(playlistKey, 'base64')
  const b = Buffer.from(body.trim(), 'base64')
  for (let i = 0; i < b.length; i++) b[i] = (b[i] as number) ^ (key[i % key.length] as number)
  return b.toString('utf8')
}

export async function extractFlixCloud(fetcher: Fetcher, embedUrl: string, referer: string): Promise<Server> {
  const res = await fetcher.request(embedUrl, { headers: { referer } })
  if (res.status !== 200) {
    await res.body.cancel()
    throw new Error(`flixcloud: embed HTTP ${res.status}`)
  }
  const embed = parseEmbed(await res.body.text())
  const origin = new URL(embedUrl).origin
  const tokenRes = await fetcher.request(`${origin}/api/m3u8/${embed.tokenRef}`, { headers: { referer: `${origin}/` } })
  const { url, playlistKey } = await decryptStream(embed, await tokenRes.body.json())
  const v = new URL(embedUrl).searchParams.get('v')
  return {
    name: `FlixCloud${v ? ` HD-${v}` : ''}`,
    streams: [
      {
        url,
        type: 'hls',
        quality: 'auto',
        headers: { ...FLIXCLOUD_HEADERS },
        playlistKey,
        ipLocked: /[?&]token=ey/.test(url) || undefined,
      },
    ],
    subtitles: embed.subtitles,
    intro: embed.intro,
    outro: embed.outro,
  }
}
