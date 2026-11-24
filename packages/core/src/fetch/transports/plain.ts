// Tier "plain": undici, no impersonation.

import { Agent, fetch } from 'undici'
import { connectLookup, defaultLookup } from '../ssrf.ts'
import type { LookupFn } from '../types.ts'
import type { Transport } from './transport.ts'

export function createPlainTransport(lookup: LookupFn = defaultLookup): Transport {
  const agents = new Map<string, Agent>()
  const agentFor = (connectMs: number, untrusted: boolean) => {
    const key = `${connectMs}|${untrusted}`
    let agent = agents.get(key)
    if (!agent) {
      // untrusted: the lookup vets every address, and the socket connects to the vetted one (no rebinding gap)
      const custom = untrusted || lookup !== defaultLookup ? { lookup: connectLookup(lookup, untrusted) } : {}
      agent = new Agent({ connect: { timeout: connectMs, ...custom } })
      agents.set(key, agent)
    }
    return agent
  }

  return {
    async request(req) {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body ?? null,
        redirect: 'manual',
        signal: req.signal,
        dispatcher: agentFor(req.connectMs, req.untrusted),
      })
      return {
        status: res.status,
        headers: new Headers(res.headers),
        body: res.body as ReadableStream<Uint8Array> | null,
      }
    },
    async close() {
      await Promise.all([...agents.values()].map((a) => a.close()))
      agents.clear()
    },
  }
}
