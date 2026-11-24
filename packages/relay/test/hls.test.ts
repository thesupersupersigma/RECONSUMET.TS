import type { TokenKind } from '@reconsumet/core'
import { describe, expect, it } from 'vitest'
import { rewritePlaylist } from '../src/hls.ts'

function recorder() {
  const minted: [string, TokenKind][] = []
  const mint = (u: string, k: TokenKind) => {
    minted.push([u, k])
    return `T${minted.length - 1}.${k}`
  }
  return { minted, mint }
}

describe('rewritePlaylist', () => {
  it('rewrites a master playlist: variants, EXT-X-MEDIA, I-frames, session key/data; drops content steering', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-CONTENT-STEERING:SERVER-URI="https://steer.example/s.json",PATHWAY-ID="A"',
      '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://cdn.example/k/session.key"',
      '#EXT-X-SESSION-DATA:DATA-ID="com.x",URI="data.json"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="ja",URI="audio/ja.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="en",URI="//cdn.example/subs/en.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud2",NAME="muxed"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="aud"',
      '720/index',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI="https://cdn.example/iframe.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000',
      'https://other.example/1080.m3u8',
      '',
    ].join('\n')
    const { minted, mint } = recorder()
    const out = rewritePlaylist(master, 'https://cdn.example/hls/master.m3u8', mint, 100)
    expect(out).toBe(
      [
        '#EXTM3U',
        '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="T0.key"',
        '#EXT-X-SESSION-DATA:DATA-ID="com.x",URI="T1.segment"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="ja",URI="T2.playlist"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="en",URI="T3.playlist"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud2",NAME="muxed"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="aud"',
        'T4.playlist',
        '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI="T5.playlist"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000',
        'T6.playlist',
        '',
      ].join('\n'),
    )
    expect(minted).toEqual([
      ['https://cdn.example/k/session.key', 'key'],
      ['https://cdn.example/hls/data.json', 'segment'],
      ['https://cdn.example/hls/audio/ja.m3u8', 'playlist'],
      ['https://cdn.example/subs/en.m3u8', 'playlist'],
      ['https://cdn.example/hls/720/index', 'playlist'],
      ['https://cdn.example/iframe.m3u8', 'playlist'],
      ['https://other.example/1080.m3u8', 'playlist'],
    ])
    expect(out).not.toMatch(/example/)
  })

  it('rewrites a media playlist: keys, MAP, PART, PRELOAD-HINT, rendition reports; keeps CRLF and blank lines', () => {
    const media = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fairplay-id",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"',
      '#EXTINF:4,',
      'seg1.ts',
      '',
      '#EXT-X-PART:DURATION=1,URI="part1.m4s"',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part2.m4s"',
      '#EXT-X-PRELOAD-HINT:TYPE=MAP,URI="init2.mp4"',
      '#EXT-X-RENDITION-REPORT:URI="../480/index.m3u8",LAST-MSN=1',
      '#EXTINF:4,',
      '/abs/seg2.ts',
      '#EXTINF:4,',
      'http://plain.example/seg3.ts',
      '#EXT-X-ENDLIST',
    ].join('\r\n')
    const { minted, mint } = recorder()
    const out = rewritePlaylist(media, 'https://cdn.example/hls/720/index.m3u8', mint, 100)
    const lines = out.split('\r\n')
    expect(lines).toEqual([
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXT-X-KEY:METHOD=AES-128,URI="T0.key",IV=0x01',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fairplay-id",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"',
      '#EXT-X-MAP:URI="T1.init",BYTERANGE="100@0"',
      '#EXTINF:4,',
      'T2.segment',
      '',
      '#EXT-X-PART:DURATION=1,URI="T3.segment"',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="T4.segment"',
      '#EXT-X-PRELOAD-HINT:TYPE=MAP,URI="T5.init"',
      '#EXT-X-RENDITION-REPORT:URI="T6.playlist",LAST-MSN=1',
      '#EXTINF:4,',
      'T7.segment',
      '#EXTINF:4,',
      'T8.segment',
      '#EXT-X-ENDLIST',
    ])
    expect(minted.map(([u]) => u)).toEqual([
      'https://cdn.example/hls/720/key.bin',
      'https://cdn.example/hls/720/init.mp4',
      'https://cdn.example/hls/720/seg1.ts',
      'https://cdn.example/hls/720/part1.m4s',
      'https://cdn.example/hls/720/part2.m4s',
      'https://cdn.example/hls/720/init2.mp4',
      'https://cdn.example/hls/480/index.m3u8',
      'https://cdn.example/abs/seg2.ts',
      'http://plain.example/seg3.ts',
    ])
    expect(out).not.toMatch(/cdn\.example|plain\.example/)
  })

  it('matches tags by exact name', () => {
    const { minted, mint } = recorder()
    rewritePlaylist(
      '#EXTM3U\n#EXT-X-KEYS:URI="a"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="b"',
      'https://h.example/',
      mint,
      10,
    )
    expect(minted).toEqual([['https://h.example/b', 'key']])
  })

  it('refuses playlists over the line cap', () => {
    const { mint } = recorder()
    expect(() => rewritePlaylist('#EXTM3U\na.ts\nb.ts', 'https://h.example/', mint, 2)).toThrow(/2 lines/)
    expect(() => rewritePlaylist('#EXTM3U\na.ts', 'https://h.example/', mint, 2)).not.toThrow()
  })
})
