// Live: both sources resolve a real episode to a playable HLS master (and the FlixCloud crypto still holds).
import { afterAll, expect, it } from 'vitest'
import { decodePlaylist } from '../src/extractors/flixcloud.ts'
import { createSources } from '../src/sources/registry.ts'

const { fetcher, sources } = createSources()
afterAll(() => fetcher.close())

it('Re:Anime: Frieren ep 1 → decrypted FlixCloud master that decodes to a real playlist', async () => {
  const ra = sources.get('reanime')!
  expect((await ra.health()).ok).toBe(true)
  const r = await ra.getStreams('154587/1')
  const st = r.servers[0]?.streams[0]
  expect(st?.url).toMatch(/^https:\/\/fetch\d+\.flixcloud\.cc\/.+\/master\.m3u8/)
  const res = await fetcher.request(st!.url, { headers: st!.headers })
  expect(decodePlaylist(await res.body.text(), st!.playlistKey!)).toMatch(/^#EXTM3U/)
  expect(r.servers[0]?.subtitles.some((s) => s.lang === 'en')).toBe(true)
})

it('AniZone: Frieren S2 ep 1 → HLS master with English subtitles', async () => {
  const az = sources.get('anizone')!
  expect((await az.health()).ok).toBe(true)
  const r = await az.getStreams('y25twzsk/1')
  const st = r.servers[0]?.streams[0]
  const res = await fetcher.request(st!.url)
  expect(await res.body.text()).toMatch(/^#EXTM3U/)
  expect(r.servers[0]?.subtitles.some((s) => s.lang === 'en' && s.default)).toBe(true)
})
