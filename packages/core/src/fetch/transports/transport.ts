// The internal interface every tier implements. The fetcher does redirects, retries, limits, cookies, SSRF
// and classification itself, so a transport only makes one HTTP exchange.

export interface TransportRequest {
  url: URL
  method: string
  headers: Record<string, string>
  body?: string | Uint8Array
  /** Aborts on total timeout or caller abort; the reason is the error to surface. */
  signal: AbortSignal
  /** Browser profile (impersonate tier). */
  profile: string
  connectMs: number
  totalMs: number
  /** Untrusted call: plain validates inside DNS lookup; impersonate gets `pinned` (already vetted addresses). */
  untrusted: boolean
  pinned?: string[]
}

export interface TransportResponse {
  status: number
  headers: Headers
  /** Decompressed body. */
  body: ReadableStream<Uint8Array> | null
}

export interface Transport {
  /** Must not follow redirects. */
  request(req: TransportRequest): Promise<TransportResponse>
  close(): Promise<void>
}
