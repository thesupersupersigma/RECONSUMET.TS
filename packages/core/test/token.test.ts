import { describe, expect, it } from 'vitest'
import { openToken, type RelayToken, sealToken } from '../src/token.ts'

const t: RelayToken = { u: 'https://cdn.example/a.m3u8', k: 'playlist', e: Date.now() + 60_000, h: { referer: 'x' } }

describe('relay tokens', () => {
  it('round-trips and hides the URL', () => {
    const s = sealToken(t, 'one')
    expect(s).not.toContain('cdn.example')
    expect(Buffer.from(s, 'base64url').toString('latin1')).not.toContain('cdn.example')
    expect(openToken(s, ['one'])).toEqual(t)
  })

  it('accepts the previous secret during a rotation, rejects unknown ones', () => {
    const s = sealToken(t, 'old')
    expect(openToken(s, ['new', 'old'])).toEqual(t)
    expect(openToken(s, ['new'])).toBeNull()
  })

  it('rejects any tampering and garbage', () => {
    const raw = Buffer.from(sealToken(t, 'one'), 'base64url')
    for (const i of [0, 13, raw.length - 1]) {
      const bad = Buffer.from(raw)
      bad[i]! ^= 1
      expect(openToken(bad.toString('base64url'), ['one'])).toBeNull()
    }
    expect(openToken('', ['one'])).toBeNull()
    expect(openToken('not-a-token', ['one'])).toBeNull()
  })
})
