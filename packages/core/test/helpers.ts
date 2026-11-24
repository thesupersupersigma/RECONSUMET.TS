import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Body } from '../src/fetch/body.ts'
import type { Fetcher } from '../src/fetch/fetcher.ts'
import type { FetchResponse, RequestOptions } from '../src/fetch/types.ts'

export interface FakeReply {
  status?: number
  body: string | Uint8Array
  headers?: Record<string, string>
}

export type FakeRoute = (url: URL, options: RequestOptions) => FakeReply | undefined

/** A Fetcher that answers from a function (fixtures), records every call, and 404s anything unrouted. */
export function fakeFetcher(route: FakeRoute) {
  const calls: { url: string; options: RequestOptions }[] = []
  const fetcher: Fetcher = {
    async request(url, options = {}): Promise<FetchResponse> {
      const u = new URL(url)
      calls.push({ url: u.href, options })
      const r = route(u, options) ?? { status: 404, body: 'not found' }
      const bytes = typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body
      return {
        status: r.status ?? 200,
        headers: new Headers(r.headers),
        url: u.href,
        tier: options.tier ?? 'plain',
        profile: null,
        timing: { startedAt: Date.now(), headersMs: 0, attempts: 1 },
        body: Body.from(bytes, u.href, 1 << 30),
      }
    },
    async close() {},
  }
  return { fetcher, calls }
}

export const fixture = (path: string) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')

export const tempDir = () => mkdtemp(join(tmpdir(), 'reconsumet-'))
