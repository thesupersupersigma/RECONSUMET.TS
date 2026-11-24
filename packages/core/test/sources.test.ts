import { describe, expect, it } from 'vitest'
import { decodePlaylist, decryptStream, deriveFieldNames, parseEmbed } from '../src/extractors/flixcloud.ts'
import { createAniZone, parseEpisodePage, parseSearch as parseAzSearch } from '../src/sources/anizone/index.ts'
import { anilistIdFromWatch, createReAnime, parseSearch as parseRaSearch } from '../src/sources/reanime/index.ts'
import { fakeFetcher, fixture } from './helpers.ts'

const fx = {
  raSearch: () => fixture('sources/reanime/__fixtures__/search.json'),
  raEpisodes: () => fixture('sources/reanime/__fixtures__/episodes.json'),
  raWatch: () => fixture('sources/reanime/__fixtures__/watch.json'),
  raServers: () => fixture('sources/reanime/__fixtures__/servers.json'),
  embed: () => fixture('extractors/__fixtures__/flixcloud-embed.html'),
  token: () => fixture('extractors/__fixtures__/flixcloud-token.json'),
  azSearch: () => fixture('sources/anizone/__fixtures__/search.html'),
  azShow: () => fixture('sources/anizone/__fixtures__/show.html'),
  azShowLong: () => fixture('sources/anizone/__fixtures__/show-long.html'),
  azLivewire: () => fixture('sources/anizone/__fixtures__/livewire-page2.json'),
  azEpisode: () => fixture('sources/anizone/__fixtures__/episode.html'),
}

// The token fixture's playlist URL was re-encrypted (fixture recorder) so no real, possibly IP-bound URL is committed.
const FIXTURE_URL = 'https://fetch8.flixcloud.cc/_v8/FIXTURE-TOKEN/master.m3u8'

describe('FlixCloud extractor', () => {
  it('derives the obfuscated field names from the seed (v1 scheme, still current)', () => {
    expect(deriveFieldNames('c6ce2226190c4410')).toEqual({
      keyFrag1: 'kf_dff8440b',
      iv: 'ivf_1b33e102',
      tokenRef: '23c81816071a3c16_071a3c16',
      keyFrag2: '8819a88dd96bb581_9d316769',
    })
  })

  it('parses the embed: fields, subtitles, intro/outro', async () => {
    const e = parseEmbed(await fx.embed())
    expect(e.seed).toMatch(/^[0-9a-f]{16}$/)
    expect(e.subtitles[0]).toMatchObject({ lang: 'en', format: 'ass', default: true })
    expect(e.subtitles.map((s) => s.format)).toContain('srt')
    expect(e.intro).toEqual({ start: 0, end: 90 })
    expect(e.outro?.start).toBeGreaterThan(1000)
  })

  it('decrypts the playlist URL through the page WASM + PBKDF2 + AES chain', async () => {
    const r = await decryptStream(parseEmbed(await fx.embed()), JSON.parse(await fx.token()))
    expect(r.url).toBe(FIXTURE_URL)
    expect(Buffer.from(r.playlistKey, 'base64')).toHaveLength(32)
  })

  it('decodes XOR-obfuscated playlists and passes plain ones through', () => {
    const key = Buffer.alloc(32, 7).toString('base64')
    const plain = '#EXTM3U\n#EXT-X-VERSION:3\nvideo.m3u8\n'
    const enc = Buffer.from(plain).map((b) => b ^ 7)
    expect(decodePlaylist(Buffer.from(enc).toString('base64'), key)).toBe(plain)
    expect(decodePlaylist(plain, key)).toBe(plain)
  })
})

describe('Re:Anime', () => {
  it('search results carry the AniList ID; the show id embeds it', async () => {
    const r = parseRaSearch(JSON.parse(await fx.raSearch()))
    expect(r[0]).toMatchObject({ id: '154587/frieren-beyond-journey-s-end-yw2a3j', anilistId: 154587, type: 'TV', year: 2023 })
    expect(r[0]?.altTitles).toContain('Frieren: Beyond Journey’s End')
  })

  it('reads the AniList ID off the cover URL of the watch payload', async () => {
    expect(anilistIdFromWatch(JSON.parse(await fx.raWatch()))).toBe(154587)
  })

  it('getShow and getStreams end to end on fixtures', async () => {
    const [eps, servers, embed, token] = await Promise.all([fx.raEpisodes(), fx.raServers(), fx.embed(), fx.token()])
    const { fetcher, calls } = fakeFetcher((u) => {
      if (u.pathname.endsWith('/episodes')) return { body: eps }
      if (u.pathname === '/api/flix/154587/1') return { body: servers }
      if (u.pathname.startsWith('/e/') && u.searchParams.get('v') === '2') return { body: embed }
      if (u.pathname.startsWith('/api/m3u8/')) return { body: token }
      if (u.pathname.startsWith('/e/')) return { status: 500, body: 'HD-1 down' } // one server failing is fine
      return undefined
    })
    const ra = createReAnime(fetcher)
    const show = await ra.getShow('154587/frieren-beyond-journey-s-end-yw2a3j')
    expect(show.episodes[0]).toMatchObject({ number: 1, id: '154587/1', sub: true, dub: true })
    expect(ra.episodeId(show.id, 7)).toBe('154587/7')

    const r = await ra.getStreams('154587/1', { audio: 'dub' })
    expect(r.servers).toHaveLength(1)
    expect(r.servers[0]?.name).toBe('HD-2 (FlixCloud)')
    expect(r.servers[0]?.streams[0]).toMatchObject({
      url: FIXTURE_URL,
      type: 'hls',
      audioLang: 'eng',
      headers: { referer: 'https://flixcloud.cc/', origin: 'https://flixcloud.cc' },
    })
    expect(calls.find((c) => c.url.includes('/e/'))?.options.headers?.referer).toBe('https://reanime.cz/')
    await expect(ra.getStreams('nope')).rejects.toThrow(/bad episode id/)
  })
})

describe('AniZone', () => {
  it('parses search results out of the Alpine JSON blob', async () => {
    const r = parseAzSearch(await fx.azSearch())
    expect(r.map((x) => [x.id, x.title, x.type, x.year, x.episodes])).toEqual([
      ['mdkytdqp', 'Sousou no Frieren', 'TV', 2023, 28],
      ['y25twzsk', 'Sousou no Frieren (2026)', 'TV', 2026, 10],
    ])
    expect(r[1]?.altTitles).toContain('Frieren: Beyond Journey`s End (2026)')
  })

  it('getShow: one page', async () => {
    const html = await fx.azShow()
    const { fetcher } = fakeFetcher(() => ({ body: html }))
    const show = await createAniZone(fetcher).getShow('y25twzsk')
    expect(show.title).toBe('Sousou no Frieren (2026)')
    expect(show.episodes.map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(show.episodes[0]).toMatchObject({ id: 'y25twzsk/1', title: 'Shall We Go, Then?' })
  })

  it('getShow: long shows page through Livewire loadPage(cursor) with the session cookie', async () => {
    const [html, reply] = await Promise.all([fx.azShowLong(), fx.azLivewire()])
    const { fetcher, calls } = fakeFetcher((u) =>
      u.pathname === '/livewire/update'
        ? { body: reply }
        : { body: html, headers: { 'set-cookie': 'anizone_session=abc; path=/; httponly' } },
    )
    const show = await createAniZone(fetcher).getShow('ul5zmckr')
    expect(show.episodes.map((e) => e.number)).toEqual([...Array.from({ length: 24 }, (_, i) => i + 1), 25, 26, 27])
    const post = calls[1]
    expect(post?.options.method).toBe('POST')
    expect(post?.options.headers?.cookie).toBe('anizone_session=abc')
    const body = JSON.parse(String(post?.options.body))
    expect(body._token).toBe('FIXTURE_CSRF_TOKEN')
    expect(body.components[0].calls[0]).toMatchObject({ method: 'loadPage', params: [expect.stringMatching(/^eyJ/)] })
    expect(JSON.parse(body.components[0].snapshot).memo.name).toBe('pages.anime-detail')
  })

  it('parses the episode player: HLS master + soft subtitles', async () => {
    const [p] = parseEpisodePage(await fx.azEpisode())
    expect(p?.src).toMatch(/^https:\/\/[a-z]+\.vid-cdn\.xyz\/[0-9a-f-]+\/master\.m3u8$/)
    expect(p?.subtitles.length).toBeGreaterThan(5)
    expect(p?.subtitles.find((s) => s.default)).toMatchObject({ lang: 'en', format: 'ass', label: 'English' })
  })

  it('getStreams: dub only when the master has an English audio track', async () => {
    const ep = await fx.azEpisode()
    const master = (en: boolean) =>
      `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",LANGUAGE="ja",URI="a.m3u8"\n${en ? '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="b.m3u8"\n' : ''}`
    for (const en of [true, false]) {
      const { fetcher } = fakeFetcher((u) => (u.hostname === 'anizone.to' ? { body: ep } : { body: master(en) }))
      const az = createAniZone(fetcher)
      if (en) {
        const r = await az.getStreams('y25twzsk/1', { audio: 'dub' })
        expect(r.servers[0]?.streams[0]).toMatchObject({ type: 'hls', audioLang: 'en', headers: {} })
      } else {
        await expect(az.getStreams('y25twzsk/1', { audio: 'dub' })).rejects.toThrow(/no dub audio/)
      }
    }
  })
})
