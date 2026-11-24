// Relay tokens: the API seals what the relay should fetch; the relay opens it. AES-256-GCM, so the browser can
// neither read the upstream URL (Re:Anime HD-1 URLs embed our IP) nor change it. Shared secret RELAY_SECRET;
// openToken takes several secrets so a rotation accepts current + previous.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export type TokenKind = 'playlist' | 'segment' | 'key' | 'init' | 'subtitle'

export interface RelayToken {
  /** Upstream URL. */
  u: string
  k: TokenKind
  /** Expiry, unix ms. */
  e: number
  /** Headers every upstream request for it needs (Referer, Origin). */
  h?: Record<string, string>
  /** FlixCloud playlist XOR key (base64); playlists only. */
  x?: string
  /** Source id, for metrics. */
  s?: string
  /** Viewer binding: only this client IP may use it (children inherit it). */
  ip?: string
}

const key = (secret: string) => createHash('sha256').update(secret).digest()

export function sealToken(token: RelayToken, secret: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(secret), iv)
  const body = Buffer.concat([c.update(JSON.stringify(token)), c.final()])
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url')
}

/** The token, or null if no secret opens it (tampered, foreign, garbage). Expiry is the caller's check. */
export function openToken(sealed: string, secrets: string[]): RelayToken | null {
  const raw = Buffer.from(sealed, 'base64url')
  if (raw.length < 12 + 16 + 2) return null
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const body = raw.subarray(12, raw.length - 16)
  for (const secret of secrets) {
    try {
      const d = createDecipheriv('aes-256-gcm', key(secret), iv)
      d.setAuthTag(tag)
      const t = JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8')) as RelayToken
      if (typeof t.u === 'string' && typeof t.k === 'string' && typeof t.e === 'number') return t
      return null
    } catch {}
  }
  return null
}
