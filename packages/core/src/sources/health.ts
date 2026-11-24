import { BlockedError } from '../fetch/errors.ts'
import type { Fetcher } from '../fetch/index.ts'
import type { Health } from './types.ts'

/** One GET; "ok" only if the classifier says it's the real site and the status is 2xx. */
export async function checkHealth(fetcher: Fetcher, url: string): Promise<Health> {
  const started = Date.now()
  try {
    const res = await fetcher.request(url, { retry: false })
    await res.body.cancel()
    return { ok: res.status < 300, status: res.status, class: 'ok', ms: Date.now() - started }
  } catch (e) {
    const ms = Date.now() - started
    if (e instanceof BlockedError) return { ok: false, status: e.status, class: e.class, ms, error: e.message }
    return { ok: false, status: null, class: 'error', ms, error: e instanceof Error ? e.message : String(e) }
  }
}
