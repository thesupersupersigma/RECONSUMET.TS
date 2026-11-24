import type { ResponseClass } from '../fetch/classify.ts'
import type { Fetcher, HostRule } from '../fetch/index.ts'

export type Audio = 'sub' | 'dub'

export interface SearchResult {
  /** The source's show id (what getShow takes). */
  id: string
  title: string
  /** Other titles the source lists (romaji, English, native, …). */
  altTitles: string[]
  /** TV | MOVIE | OVA | ONA | SPECIAL | UNKNOWN (catalog vocabulary). */
  type?: string
  year?: number
  episodes?: number
  /** Set when the source itself says which AniList entry this is (exact match, no guessing). */
  anilistId?: number
}

export interface Episode {
  number: number
  title?: string
  /** What getStreams takes. */
  id: string
  /** undefined = the source doesn't say without fetching the episode. */
  sub?: boolean
  dub?: boolean
}

export interface Show {
  id: string
  title: string
  episodes: Episode[]
  anilistId?: number
}

export interface Stream {
  url: string
  type: 'hls' | 'mp4'
  /** "auto" for an HLS master with several renditions. */
  quality: string
  /** Headers every request for this stream (playlists, keys, segments) must carry. */
  headers: Record<string, string>
  /** Audio track to select in a multi-audio master (BCP-47 / ISO 639 code as the playlist names it). */
  audioLang?: string
  /**
   * Playlists come back base64 + XOR'd with this 32-byte key (base64). The proxy must decode every playlist body:
   * `plain[i] = b64decode(body)[i] ^ key[i % 32]`. Segments and keys are plain.
   */
  playlistKey?: string
  /** The URL is signed for the IP that resolved it: it only plays through a relay on that IP. */
  ipLocked?: boolean
}

export interface Subtitle {
  lang: string
  label: string
  url: string
  format: 'vtt' | 'ass' | 'srt'
  default: boolean
}

export interface Server {
  name: string
  streams: Stream[]
  subtitles: Subtitle[]
  /** Seconds. */
  intro?: { start: number; end: number }
  outro?: { start: number; end: number }
}

export interface StreamResult {
  servers: Server[]
}

export interface Health {
  ok: boolean
  status: number | null
  class: ResponseClass | 'error'
  ms: number
  error?: string
}

export interface Source {
  /** Stable id used in mappings and the CLI ("reanime"). */
  id: string
  name: string
  baseUrl: string
  search(query: string): Promise<SearchResult[]>
  getShow(id: string): Promise<Show>
  /** The episode id for a show + episode number, without a request (both sources derive it from the number). */
  episodeId(showId: string, episode: number): string
  getStreams(episodeId: string, options?: { audio?: Audio }): Promise<StreamResult>
  health(): Promise<Health>
}

export interface SourceDefinition {
  id: string
  name: string
  /** Per-host fetcher rules (tier, rate limit, headers) for the site and its video hosts. */
  hostRules: HostRule[]
  create(fetcher: Fetcher): Source
}
