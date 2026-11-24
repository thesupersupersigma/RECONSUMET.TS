// HLS playlist rewriting: every URI in the playlist becomes a relay token, so the browser never sees an upstream URL.
import type { TokenKind } from '@reconsumet/core'

/** Tags whose URI="…" attribute is rewritten, and what that URI points at. Matched by exact name up to the colon. */
const URI_TAGS: Record<string, TokenKind> = {
  '#EXT-X-MEDIA': 'playlist',
  '#EXT-X-I-FRAME-STREAM-INF': 'playlist',
  '#EXT-X-RENDITION-REPORT': 'playlist',
  '#EXT-X-KEY': 'key',
  '#EXT-X-SESSION-KEY': 'key',
  '#EXT-X-MAP': 'init',
  '#EXT-X-PART': 'segment',
  '#EXT-X-PRELOAD-HINT': 'segment',
  '#EXT-X-SESSION-DATA': 'segment',
}

/**
 * Rewrites every URI through `mint` (absolute upstream URL → what to write instead). `baseUrl` is the playlist's
 * final URL after redirects. URIs with other schemes (skd://, data:) stay as they are. Throws past `maxLines`.
 */
export function rewritePlaylist(
  text: string,
  baseUrl: string,
  mint: (absUrl: string, kind: TokenKind) => string,
  maxLines: number,
): string {
  const lines = text.split('\n') // a trailing \r stays on its line, so CRLF survives
  if (lines.length > maxLines) throw new Error(`playlist longer than ${maxLines} lines`)
  const resolve = (uri: string) => {
    const u = new URL(uri, baseUrl)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  }
  const out: string[] = []
  let variant = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      out.push(raw)
    } else if (line.startsWith('#')) {
      const colon = line.indexOf(':')
      const tag = colon === -1 ? line : line.slice(0, colon)
      if (tag === '#EXT-X-CONTENT-STEERING') continue // its SERVER-URI would send the player upstream
      if (tag === '#EXT-X-STREAM-INF') variant = true
      let kind = URI_TAGS[tag]
      if (kind && tag === '#EXT-X-PRELOAD-HINT' && /[:,]TYPE=MAP(,|$)/.test(line)) kind = 'init'
      out.push(
        kind
          ? raw.replace(/([:,]URI=")([^"]*)"/, (all, pre: string, uri: string) => {
              const abs = uri && resolve(uri)
              return abs ? `${pre}${mint(abs.href, kind)}"` : all
            })
          : raw,
      )
    } else {
      const abs = resolve(line)
      const kind = variant || abs?.pathname.toLowerCase().endsWith('.m3u8') ? 'playlist' : 'segment'
      variant = false
      out.push(abs ? raw.replace(line, () => mint(abs.href, kind)) : raw)
    }
  }
  return out.join('\n')
}
