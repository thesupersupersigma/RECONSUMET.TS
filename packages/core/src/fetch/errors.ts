import type { ResponseClass } from './classify.ts'
import type { Tier } from './types.ts'

/** Base class: every error the fetcher throws on purpose is a FetchError. */
export class FetchError extends Error {
  override name = 'FetchError'
  readonly url: string
  constructor(message: string, url: string, options?: ErrorOptions) {
    super(message, options)
    this.url = url
  }
}

/** Connect or total timeout hit. */
export class FetchTimeoutError extends FetchError {
  override name = 'FetchTimeoutError'
  readonly phase: 'connect' | 'total'
  readonly ms: number
  constructor(url: string, phase: 'connect' | 'total', ms: number, options?: ErrorOptions) {
    super(`${phase} timeout after ${ms} ms: ${url}`, url, options)
    this.phase = phase
    this.ms = ms
  }
}

/** DNS failure, refused connection, reset, TLS error… (retried for GET/HEAD). */
export class FetchNetworkError extends FetchError {
  override name = 'FetchNetworkError'
}

/** The response was a block page / challenge / rate limit, not the real content. */
export class BlockedError extends FetchError {
  override name = 'BlockedError'
  readonly class: Exclude<ResponseClass, 'ok'>
  readonly status: number
  readonly tier: Tier
  constructor(cls: Exclude<ResponseClass, 'ok'>, status: number, url: string, tier: Tier) {
    super(`blocked (${cls}, HTTP ${status}, tier ${tier}): ${url}`, url)
    this.class = cls
    this.status = status
    this.tier = tier
  }
}

/** An untrusted URL (or one of its redirects) points somewhere we must not connect to. */
export class SsrfError extends FetchError {
  override name = 'SsrfError'
}

/** The body (or its Content-Length) is over the size cap. */
export class TooLargeError extends FetchError {
  override name = 'TooLargeError'
  readonly limit: number
  constructor(url: string, limit: number) {
    super(`response larger than ${limit} bytes: ${url}`, url)
    this.limit = limit
  }
}

export class TooManyRedirectsError extends FetchError {
  override name = 'TooManyRedirectsError'
}

/** The `solver` tier is a stub until the Cloudflare-solver milestone. */
export class SolverNotImplementedError extends FetchError {
  override name = 'SolverNotImplementedError'
  constructor(url: string) {
    super(`the "solver" tier is not implemented yet (see brainstorm 2.6): ${url}`, url)
  }
}
