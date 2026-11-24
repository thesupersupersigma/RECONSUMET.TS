// Typed client for the RECONSUMΣT.TS API: routes, params and responses come from the API's own Hono app type,
// so the site and the API can't drift apart (brainstorm 1.6).
import type { AppType } from '@reconsumet/api'
import { hc } from 'hono/client'

export * from '@reconsumet/api/schemas'

export interface ClientOptions {
  /** Server-to-server key (needed for streams). Never ship it to a browser. */
  apiKey?: string
  fetch?: typeof fetch
}

export function createClient(baseUrl: string, opts: ClientOptions = {}) {
  return hc<AppType>(baseUrl, {
    headers: opts.apiKey ? { 'x-api-key': opts.apiKey } : {},
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })
}

export type Client = ReturnType<typeof createClient>
