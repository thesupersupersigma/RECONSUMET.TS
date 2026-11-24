import { describe, expect, it } from 'vitest'
import { createAniSkip } from '../src/aniskip.ts'
import { DiskCache } from '../src/data.ts'
import { fakeFetcher, fixture, tempDir } from './helpers.ts'

describe('AniSkip', () => {
  it('maps op/ed to intro/outro, caches per MAL ID + episode + rounded length', async () => {
    const hit = await fixture('__fixtures__/skip-1535-1-1377.json')
    const miss = await fixture('__fixtures__/skip-miss.json')
    const { fetcher, calls } = fakeFetcher((u) =>
      u.pathname === '/v2/skip-times/1535/1' && u.searchParams.get('episodeLength') === '1377'
        ? { body: hit }
        : { status: 404, body: miss },
    )
    const s = createAniSkip({ fetcher, cache: new DiskCache(await tempDir()), url: 'https://skip.example/' })
    expect(await s.skipTimes(1535, 1, 1377.3)).toEqual({
      intro: { start: 1.039, end: 91.039 },
      outro: { start: 1284, end: 1377 },
      source: 'aniskip',
    })
    expect(decodeURIComponent(calls[0]?.url ?? '')).toBe(
      'https://skip.example/v2/skip-times/1535/1?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed&episodeLength=1377',
    )
    await s.skipTimes(1535, 1, 1376.8) // same rounded length → cache
    expect(calls).toHaveLength(1)
    expect(await s.skipTimes(1535, 2, 1377)).toEqual({ source: 'none' }) // 404 = not found
    await s.skipTimes(1535, 2, 1377) // misses are cached too
    expect(calls).toHaveLength(2)
  })

  it('throws on AniSkip errors (not cached)', async () => {
    const { fetcher } = fakeFetcher(() => ({ status: 503, body: 'down' }))
    const s = createAniSkip({ fetcher, cache: new DiskCache(await tempDir()) })
    await expect(s.skipTimes(1, 1, 1400)).rejects.toThrow(/HTTP 503/)
  })
})
