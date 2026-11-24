import { CookieJar } from 'tough-cookie'
import { Body } from './body.ts'
import { classify, needsBody, type ResponseClass } from './classify.ts'
import {
  BlockedError,
  FetchError,
  FetchNetworkError,
  FetchTimeoutError,
  SsrfError,
  TooLargeError,
  TooManyRedirectsError,
} from './errors.ts'
import { HostGate, type Release, Semaphore, sleep } from './limiter.ts'
import { checkUrl, defaultLookup, resolveSafe } from './ssrf.ts'
import { createImpersonateTransport } from './transports/impersonate.ts'
import { createPlainTransport } from './transports/plain.ts'
import { createSolverTransport } from './transports/solver.ts'
import type { Transport } from './transports/transport.ts'
import type { FetchEvent, FetcherConfig, FetchResponse, HostRule, RequestOptions, RetryOptions, Tier } from './types.ts'

export interface Fetcher {
  request(url: string | URL, options?: RequestOptions): Promise<FetchResponse>
  /** Close pooled connections. */
  close(): Promise<void>
}

/** Classes that a browser fingerprint can plausibly get past: escalation from plain to impersonate. */
const FINGERPRINT_BLOCKED = new Set<ResponseClass>(['forbidden', 'cf-challenge', 'cf-block', 'ddos-guard'])
const REDIRECT = new Set([301, 302, 303, 307, 308])
const PER_HOST_CONCURRENCY = 8 // when no rule sets one

interface Attempt {
  response: FetchResponse
  cls: ResponseClass
  /** Set before cancelling a body we drop (retry, escalation) so it doesn't emit an event. */
  silence(): void
}

export function createFetcher(config: FetcherConfig = {}): Fetcher {
  const lookup = config.lookup ?? defaultLookup
  const baseTimeout = { connectMs: 10_000, totalMs: 30_000, ...config.timeout }
  const baseRetry: RetryOptions = { attempts: 2, baseMs: 500, maxMs: 30_000, methods: ['GET', 'HEAD'], ...config.retry }
  const maxBytesDefault = config.maxBytes ?? 64 * 1024 * 1024
  const maxRedirectsDefault = config.maxRedirects ?? 5
  const rules = [...(config.rules ?? [])].sort((a, b) => b.match.length - a.match.length)
  const ruleFor = (host: string): HostRule | undefined =>
    rules.find((r) => host === r.match || host.endsWith(`.${r.match}`))

  const global = new Semaphore(config.maxConcurrency ?? 64)
  // shortcut: one gate per host forever; prune idle gates if a long-running proxy sees unbounded hosts
  const gates = new Map<string, HostGate>()
  const escalatedUntil = new Map<string, number>()
  const jar = config.cookies ? new CookieJar() : null
  const transports: Record<Tier, Transport> = {
    plain: createPlainTransport(lookup),
    impersonate: createImpersonateTransport(),
    solver: createSolverTransport(),
  }

  const emit = (e: FetchEvent) => {
    try {
      config.onEvent?.(e)
    } catch {} // a broken listener must not break requests
  }

  async function acquire(host: string, rule: HostRule | undefined, signal: AbortSignal): Promise<Release> {
    let gate = gates.get(host)
    if (!gate) {
      gate = new HostGate(rule?.concurrency ?? PER_HOST_CONCURRENCY, rule?.rateLimit)
      gates.set(host, gate)
    }
    const hostRelease = await gate.acquire(signal) // host first, so a rate-limited host holds no global slot
    try {
      const globalRelease = await global.acquire(signal)
      return () => {
        globalRelease()
        hostRelease()
      }
    } catch (e) {
      hostRelease()
      throw e
    }
  }

  function buildHeaders(host: string, opts: RequestOptions, crossOrigin: boolean): Headers {
    const h = new Headers(config.headers)
    for (const [k, v] of Object.entries(ruleFor(host)?.headers ?? {})) h.set(k, v)
    for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v)
    if (crossOrigin) {
      h.delete('authorization') // never leak credentials to a host we were redirected to
      h.delete('cookie')
    }
    return h
  }

  /** One attempt: the redirect chain up to the final response (body not read yet, unless needed to classify). */
  async function attempt(
    start: URL,
    tier: Tier,
    opts: RequestOptions,
    retries: number,
    escalated: boolean,
  ): Promise<Attempt> {
    const rule = ruleFor(start.hostname)
    const profile = tier === 'plain' ? null : (opts.profile ?? rule?.profile ?? config.profile ?? 'chrome')
    const timeout = { ...baseTimeout, ...rule?.timeout, ...opts.timeout }
    const maxBytes = opts.maxBytes ?? maxBytesDefault
    const maxRedirects = opts.maxRedirects ?? maxRedirectsDefault
    const startedAt = Date.now()
    const t0 = performance.now()

    let current = start
    const ac = new AbortController()
    const timer = setTimeout(
      () => ac.abort(new FetchTimeoutError(current.href, 'total', timeout.totalMs)),
      timeout.totalMs,
    )
    const signal = opts.signal ? AbortSignal.any([ac.signal, opts.signal]) : ac.signal
    let release: Release | undefined
    let method = (opts.method ?? 'GET').toUpperCase()
    let body = opts.body
    let silent = false

    const finish = (status: number | null, cls: ResponseClass | null, bytes: number, error?: unknown) => {
      clearTimeout(timer)
      release?.()
      release = undefined
      if (silent) return
      emit({
        host: current.hostname,
        url: current.href,
        tier,
        profile,
        status,
        class: cls,
        ms: Math.round(performance.now() - t0),
        bytes,
        retries,
        escalated,
        ...(error ? { error: (error as Error).name ?? 'Error' } : {}),
      })
    }

    try {
      for (let hop = 0; ; hop++) {
        const host = opts.untrusted ? checkUrl(current) : current.hostname
        const pinned =
          opts.untrusted && tier === 'impersonate' ? await resolveSafe(host, current.href, lookup) : undefined
        const headers = buildHeaders(current.hostname, opts, current.origin !== start.origin)
        if (jar) {
          const cookie = await jar.getCookieString(current.href)
          if (cookie) headers.set('cookie', cookie)
        }

        release = await acquire(current.hostname, ruleFor(current.hostname), signal)
        const res = await transports[tier].request({
          url: current,
          method,
          headers: Object.fromEntries(headers),
          body,
          signal,
          profile: profile ?? '',
          connectMs: timeout.connectMs,
          totalMs: timeout.totalMs,
          untrusted: !!opts.untrusted,
          pinned,
        })
        if (jar) {
          for (const c of res.headers.getSetCookie()) await jar.setCookie(c, current.href, { ignoreError: true })
        }

        const location = res.headers.get('location')
        if (REDIRECT.has(res.status) && location) {
          await res.body?.cancel().catch(() => {})
          release()
          release = undefined
          if (hop >= maxRedirects) throw new TooManyRedirectsError(`more than ${maxRedirects} redirects`, start.href)
          if (
            res.status === 303 ? method !== 'HEAD' : (res.status === 301 || res.status === 302) && method === 'POST'
          ) {
            method = 'GET'
            body = undefined
          }
          current = new URL(location, current) // next hop re-runs checkUrl/resolveSafe when untrusted
          continue
        }

        const length = Number(res.headers.get('content-length'))
        if (!res.headers.has('content-encoding') && length > maxBytes) {
          await res.body?.cancel().catch(() => {})
          throw new TooLargeError(current.href, maxBytes)
        }

        let cls: ResponseClass
        let out: Body
        const done = (bytes: number, error?: unknown) => finish(res.status, cls, bytes, error)
        if (needsBody(res.status)) {
          const buf = await new Body(res.body, current.href, maxBytes).bytes()
          cls = classify({
            status: res.status,
            headers: res.headers,
            body: new TextDecoder().decode(buf.subarray(0, 32768)),
          })
          out = Body.from(buf, current.href, maxBytes, done)
        } else {
          cls = classify({ status: res.status, headers: res.headers })
          out = new Body(res.body, current.href, maxBytes, done)
        }
        return {
          response: {
            status: res.status,
            headers: res.headers,
            url: current.href,
            tier,
            profile,
            timing: { startedAt, headersMs: Math.round(performance.now() - t0), attempts: retries + 1 },
            body: out,
          },
          cls,
          silence: () => {
            silent = true
          },
        }
      }
    } catch (e) {
      clearTimeout(timer)
      release?.()
      throw toFetchError(e, current.href, signal, timeout.connectMs)
    }
  }

  /** attempt() with retries for network errors, 5xx and 429 (GET/HEAD by default), honouring Retry-After. */
  async function withRetries(url: URL, tier: Tier, opts: RequestOptions, escalated: boolean): Promise<Attempt> {
    const retry = opts.retry === false ? { ...baseRetry, attempts: 0 } : { ...baseRetry, ...opts.retry }
    const canRetry = retry.methods.includes((opts.method ?? 'GET').toUpperCase())
    const backoff = (n: number) => {
      const cap = Math.min(retry.maxMs, retry.baseMs * 2 ** n)
      return cap / 2 + Math.random() * (cap / 2) // "equal jitter": never ~0, never over the cap
    }
    const t0 = performance.now()
    for (let n = 0; ; n++) {
      let a: Attempt
      try {
        a = await attempt(url, tier, opts, n, escalated)
      } catch (e) {
        const retriable = e instanceof FetchNetworkError || e instanceof FetchTimeoutError
        if (canRetry && retriable && n < retry.attempts && !opts.signal?.aborted) {
          await sleep(backoff(n), opts.signal)
          continue
        }
        emit({
          host: url.hostname,
          url: url.href,
          tier,
          profile: null,
          status: null,
          class: null,
          ms: Math.round(performance.now() - t0),
          bytes: 0,
          retries: n,
          escalated,
          error: (e as Error).name,
        })
        throw e
      }
      const { status, headers } = a.response
      const retriable = (status >= 500 && a.cls === 'ok') || a.cls === 'rate-limited'
      if (canRetry && retriable && n < retry.attempts) {
        const wait = retryAfterMs(headers.get('retry-after')) ?? backoff(n)
        if (wait <= retry.maxMs) {
          a.silence()
          await a.response.body.cancel()
          await sleep(wait, opts.signal)
          continue
        }
      }
      return a
    }
  }

  return {
    async request(input, opts = {}) {
      const url = new URL(input)
      if (opts.untrusted) checkUrl(url)
      const host = url.hostname
      const until = escalatedUntil.get(host)
      if (until !== undefined && until < Date.now()) escalatedUntil.delete(host)
      const remembered = escalatedUntil.has(host)
      const tier: Tier = opts.tier ?? (remembered ? 'impersonate' : (ruleFor(host)?.tier ?? config.tier ?? 'plain'))

      let a = await withRetries(url, tier, opts, remembered)
      if (config.escalate && !opts.tier && tier === 'plain' && FINGERPRINT_BLOCKED.has(a.cls)) {
        await a.response.body.cancel() // emits the plain attempt's event (with its class)
        a = await withRetries(url, 'impersonate', opts, true)
        if (a.cls === 'ok') escalatedUntil.set(host, Date.now() + config.escalate.ttlMs)
      }
      if (a.cls !== 'ok') {
        await a.response.body.cancel()
        throw new BlockedError(a.cls, a.response.status, a.response.url, a.response.tier)
      }
      return a.response
    },
    async close() {
      await Promise.all(Object.values(transports).map((t) => t.close()))
    },
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const s = Number(value)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

function toFetchError(e: unknown, url: string, signal: AbortSignal, connectMs: number): unknown {
  if (e instanceof FetchError) return e
  if (signal.aborted) return signal.reason // our FetchTimeoutError, or the caller's own abort reason
  const cause = (e as { cause?: unknown })?.cause
  if (cause instanceof SsrfError) return new SsrfError(cause.message, url)
  if ((cause as { code?: string })?.code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new FetchTimeoutError(url, 'connect', connectMs, { cause: e })
  }
  return new FetchNetworkError(
    `request failed: ${url}: ${(cause as Error)?.message ?? (e as Error)?.message ?? e}`,
    url,
    { cause: e },
  )
}
