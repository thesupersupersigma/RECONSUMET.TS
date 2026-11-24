import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { Bucket, createLimits } from '../src/limits.ts'

describe('Bucket', () => {
  it('sends 1 MB at 4 Mbit/s in ~1 s after the 1 s burst (~2 s from empty)', () => {
    const rate = 4_000_000 / 8
    const b = new Bucket(rate, 0)
    let now = 0
    for (let sent = 0; sent < 1_000_000; sent += 15_625) now += b.take(15_625, now)
    expect(now).toBeGreaterThan(990)
    expect(now).toBeLessThan(1010)
    // the bucket is now empty: another 1 MB takes the full 2 s
    const start = now
    for (let sent = 0; sent < 1_000_000; sent += 15_625) now += b.take(15_625, now)
    expect(now - start).toBeGreaterThan(1990)
    expect(now - start).toBeLessThan(2010)
  })

  it('refills continuously and caps the burst at 1 s of rate', () => {
    const b = new Bucket(1000, 0)
    expect(b.take(1000, 0)).toBe(0)
    expect(b.take(500, 0)).toBe(500)
    expect(b.take(0, 10_000)).toBe(0) // long idle refills to the cap only
    expect(b.take(1500, 10_000)).toBe(500)
  })
})

describe('createLimits', () => {
  it('limits streams per IP and releases once', () => {
    const l = createLimits({ maxStreamsPerIp: 2, ipBytesPerSec: 1e9, globalBytesPerSec: 1e9 })
    const a = l.open('1.1.1.1')
    const b = l.open('1.1.1.1')
    expect(a && b).toBeTruthy()
    expect(l.open('1.1.1.1')).toBeNull()
    expect(l.open('2.2.2.2')).toBeTruthy()
    a!()
    a!()
    expect(l.stats.activeStreams).toBe(2)
    expect(l.open('1.1.1.1')).toBeTruthy()
    expect(l.open('1.1.1.1')).toBeNull()
  })

  it('no global ceiling when unset', async () => {
    const l = createLimits({ maxStreamsPerIp: 1, ipBytesPerSec: 1e9 })
    const body = new Blob([new Uint8Array(200_000)]).stream()
    const out = await new Response(l.pipe('1.1.1.1', body, () => {})).arrayBuffer()
    expect(out.byteLength).toBe(200_000)
    expect(l.stats.throttledMs).toBe(0)
  })
})

describe('loadConfig', () => {
  it('applies defaults and converts units', () => {
    const c = loadConfig({
      RELAY_SECRET: 'x'.repeat(32),
      RELAY_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    })
    expect(c).toMatchObject({
      secrets: ['x'.repeat(32)],
      allowedOrigins: ['https://a.example', 'https://b.example'],
      port: 8081,
      metricsToken: undefined,
      maxStreamsPerIp: 6,
      ipBytesPerSec: 1_500_000,
      globalBytesPerSec: undefined,
      clientIpHeader: 'x-forwarded-for',
      childTtlMs: 360 * 60_000,
      maxPlaylistLines: 20_000,
      maxSegmentBytes: 64 * 1024 * 1024,
    })
  })

  it('throws clear errors', () => {
    expect(() => loadConfig({})).toThrow(/RELAY_SECRET is required/)
    expect(() => loadConfig({ RELAY_SECRET: 'short' })).toThrow(/at least 32/)
    expect(() => loadConfig({ RELAY_SECRET: 'x'.repeat(32), PORT: 'abc' })).toThrow(/PORT must be a positive integer/)
    expect(() => loadConfig({ RELAY_SECRET: 'x'.repeat(32), RELAY_IP_MBPS: '-1' })).toThrow(/RELAY_IP_MBPS/)
    expect(loadConfig({ RELAY_SECRET: 'x'.repeat(32), RELAY_GLOBAL_MBPS: '32' }).globalBytesPerSec).toBe(4_000_000)
    expect(loadConfig({ RELAY_SECRET: 'x'.repeat(32), RELAY_SECRET_PREVIOUS: 'y'.repeat(32) }).secrets).toHaveLength(2)
  })
})
