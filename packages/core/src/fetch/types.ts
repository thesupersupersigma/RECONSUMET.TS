import type { LookupAddress } from 'node:dns'
import type { Body } from './body.ts'
import type { ResponseClass } from './classify.ts'

export type Tier = 'plain' | 'impersonate' | 'solver'

export interface Timeouts {
  /** TCP + TLS connect. Default 10 000. */
  connectMs: number
  /** Whole attempt: redirects + headers + reading the body. Default 30 000. */
  totalMs: number
}

export interface RetryOptions {
  /** Retries after the first try. Default 2. */
  attempts: number
  /** First backoff; doubles each retry, with full jitter. Default 500. */
  baseMs: number
  /** Longest wait between tries, Retry-After included. A longer Retry-After stops retrying. Default 30 000. */
  maxMs: number
  /** Methods that are retried. Default GET, HEAD. */
  methods: string[]
}

export interface HostRule {
  /** Host suffix: "example.com" matches example.com and every subdomain. The longest matching rule wins. */
  match: string
  tier?: Tier
  /** Browser profile for the impersonate tier, e.g. "chrome" or "chrome_149". */
  profile?: string
  /** Default headers (Referer, Origin, …) for this host; per-call headers win. */
  headers?: Record<string, string>
  /** At most `requests` request starts per `perMs` for this host. */
  rateLimit?: { requests: number; perMs: number }
  /** Requests in flight at once for this host (until each body is consumed). */
  concurrency?: number
  timeout?: Partial<Timeouts>
}

export type LookupFn = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>

export interface FetcherConfig {
  /** Tier when no rule or call says otherwise. Default "plain". */
  tier?: Tier
  /** Default browser profile for the impersonate tier. Default "chrome" (newest Chrome). */
  profile?: string
  /** Headers sent on every request (lowest priority). */
  headers?: Record<string, string>
  rules?: HostRule[]
  timeout?: Partial<Timeouts>
  /** Body size cap in bytes, enforced on Content-Length and while streaming. Default 64 MiB. */
  maxBytes?: number
  /** Default 5. */
  maxRedirects?: number
  retry?: Partial<RetryOptions>
  /** Requests in flight across all hosts. Default 64. */
  maxConcurrency?: number
  /**
   * Retry a fingerprint-blocked `plain` response through `impersonate`, and remember that host for `ttlMs`.
   * Off unless set.
   */
  escalate?: { ttlMs: number }
  /** Keep cookies between requests of this fetcher (in memory). Default false. */
  cookies?: boolean
  /** One event per request, after its body is consumed, cancelled or failed. */
  onEvent?: (event: FetchEvent) => void
  /** DNS override (tests, split-horizon setups). Default: the OS resolver. */
  lookup?: LookupFn
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  /** Force a tier for this call (disables escalation). */
  tier?: Tier
  profile?: string
  /** The URL came from outside (user input, a playlist): run the SSRF guard on it and on every redirect. */
  untrusted?: boolean
  timeout?: Partial<Timeouts>
  maxBytes?: number
  maxRedirects?: number
  /** `false` = no retries for this call. */
  retry?: Partial<RetryOptions> | false
  signal?: AbortSignal
}

export interface FetchResponse {
  status: number
  headers: Headers
  /** Final URL after redirects. */
  url: string
  tier: Tier
  /** Browser profile used, or null for the plain tier. */
  profile: string | null
  timing: { startedAt: number; headersMs: number; attempts: number }
  body: Body
}

export interface FetchEvent {
  host: string
  url: string
  tier: Tier
  profile: string | null
  status: number | null
  class: ResponseClass | null
  ms: number
  bytes: number
  retries: number
  escalated: boolean
  /** Error name if the request failed (FetchTimeoutError, SsrfError, …). */
  error?: string
}
