// Tier "solver": a Cloudflare-challenge solver (Byparr-like) comes in its own milestone, see brainstorm 2.6.

import { SolverNotImplementedError } from '../errors.ts'
import type { Transport } from './transport.ts'

export function createSolverTransport(): Transport {
  return {
    async request(req) {
      throw new SolverNotImplementedError(req.url.href)
    },
    async close() {},
  }
}
