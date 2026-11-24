// Typed client for the RECONSUMΣT.TS API: routes, params and responses come from the API's own Hono app type,
// so the site and the API can't drift apart (brainstorm 1.6).
import type { AppType as ServerApp } from '@reconsumet/api'
import type { Hono } from 'hono'
import { hc } from 'hono/client'
import type { BlankEnv } from 'hono/types'

// An unaliased conditional makes tsc print the route table as plain object types in dist/index.d.ts, so the published
// .d.ts needs only `hono` — not @reconsumet/api, its database layer or zod (checked by `pnpm test:pack`).
const routes = (() => null as unknown as ServerApp extends Hono<infer _E, infer S, infer _B> ? S : never)()
export type ApiSchema = typeof routes
export type AppType = Hono<BlankEnv, ApiSchema, '/'>

type Ok<P extends keyof ApiSchema> = Extract<ApiSchema[P]['$get'], { status: 200 }>['output']
type Err<P extends keyof ApiSchema> = Extract<ApiSchema[P]['$get'], { status: 404 }>['output']

export type CatalogEntryT = Ok<'/v1/search'>[number]
export type AnimeT = Ok<'/v1/anime/:anilistId'>
export type SourceT = Ok<'/v1/sources'>[number]
export type EpisodesT = Ok<'/v1/anime/:anilistId/episodes'>
export type StreamsT = Ok<'/v1/anime/:anilistId/episodes/:episode/streams'>
export type ApiError = Err<'/v1/anime/:anilistId'>

export interface ClientOptions {
  /** Server-to-server key (needed for streams). Never ship it to a browser. */
  apiKey?: string
  fetch?: typeof fetch
}

export type Client = ReturnType<typeof hc<AppType>>

export function createClient(baseUrl: string, opts: ClientOptions = {}): Client {
  return hc<AppType>(baseUrl, {
    headers: opts.apiKey ? { 'x-api-key': opts.apiKey } : {},
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })
}
