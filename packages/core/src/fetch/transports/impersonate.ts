// Tier "impersonate": browser TLS/HTTP-2 fingerprints via rustyTLS-js (our fork of wreq-js; npm name still
// "wreq-js" until the rename). The only file that knows which library does impersonation: swap it here.

import { FetchError } from '../errors.ts'
import type { Transport } from './transport.ts'

type Wreq = typeof import('wreq-js')
type WreqTransport = Awaited<ReturnType<Wreq['createTransport']>>

let lib: Promise<Wreq> | undefined
const load = (url: string) =>
  (lib ??= import('wreq-js').catch((e: unknown) => {
    lib = undefined
    throw new FetchError('the impersonate tier needs rustyTLS-js (npm name "wreq-js") installed', url, { cause: e })
  }))

export function createImpersonateTransport(): Transport {
  // one pooled transport per profile + connect timeout (keeps connections and TLS sessions warm)
  const pools = new Map<string, Promise<WreqTransport>>()

  return {
    async request(req) {
      const wreq = await load(req.url.href)
      const base = {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: 'manual' as const,
        signal: req.signal,
        timeout: req.totalMs,
      }
      if (req.pinned) {
        // Untrusted: a transport pinned to the vetted addresses (wreq-js 3.2.0 only takes `resolve` on transports).
        // shortcut: one unpooled transport per untrusted request; cache per host+addresses if handshakes show up in the proxy.
        const pinned = await wreq.createTransport({
          browser: req.profile as never,
          connectTimeout: req.connectMs,
          resolve: { [req.url.hostname]: req.pinned },
        })
        const close = () => void pinned.close().catch(() => {})
        try {
          const res = await wreq.fetch(req.url.href, { ...base, transport: pinned })
          if (!res.body) close()
          return {
            status: res.status,
            headers: new Headers([...res.headers]),
            body: res.body && onEnd(res.body, close),
          }
        } catch (e) {
          close()
          throw e
        }
      }
      const key = `${req.profile}|${req.connectMs}`
      let pool = pools.get(key)
      if (!pool) {
        pool = wreq.createTransport({ browser: req.profile as never, connectTimeout: req.connectMs })
        pool.catch(() => pools.delete(key))
        pools.set(key, pool)
      }
      const res = await wreq.fetch(req.url.href, { ...base, transport: await pool })
      return { status: res.status, headers: new Headers([...res.headers]), body: res.body }
    },
    async close() {
      const all = await Promise.allSettled(pools.values())
      pools.clear()
      await Promise.all(all.map((p) => (p.status === 'fulfilled' ? p.value.close() : undefined)))
    },
  }
}

/** Pass a stream through, calling `fn` once when it ends, fails or is cancelled. */
function onEnd(stream: ReadableStream<Uint8Array>, fn: () => void): ReadableStream<Uint8Array> {
  const reader = stream.getReader()
  return new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            c.close()
            fn()
          } else c.enqueue(value)
        } catch (e) {
          c.error(e)
          fn()
        }
      },
      cancel(reason) {
        fn()
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}
