// Response classifier: is this response the real site, or something standing in front of it?
// Pure and import-free on purpose: sources, health checks and tools/tls-bakeoff all import this file
// (Node runs it directly with type stripping).

export type ResponseClass =
  | 'ok' // not blocked (the status may still be an error; check it yourself)
  | 'cf-challenge' // Cloudflare JS / managed challenge ("Just a moment...")
  | 'cf-block' // Cloudflare firewall block (1020, 1010, 1006-1012 access denied)
  | 'ddos-guard' // DDoS-Guard check page
  | 'forbidden' // some other 403 / 401
  | 'rate-limited' // 429 or Cloudflare 1015

export interface ClassifyInput {
  status: number
  /** Header lookup; pass a `Headers` or anything with a case-insensitive `get`. */
  headers: { get(name: string): string | null }
  /** The start of the body (a few KB is enough). Empty if not read. */
  body?: string
}

/** Statuses for which the body is worth reading before classifying. */
export function needsBody(status: number): boolean {
  return status === 403 || status === 429 || status === 503 || status === 401
}

export function classify({ status, headers, body = '' }: ClassifyInput): ResponseClass {
  const server = (headers.get('server') ?? '').toLowerCase()
  const isCf = server.includes('cloudflare') || headers.get('cf-ray') !== null
  const mitigated = (headers.get('cf-mitigated') ?? '').toLowerCase()

  if (mitigated === 'challenge') return 'cf-challenge'
  if (status === 429 || /error code:?\s*1015\b/i.test(body)) return 'rate-limited'

  if (isCf) {
    if (/<title>\s*Just a moment\.\.\.|challenges\.cloudflare\.com|cf_chl_opt|cf-browser-verification/i.test(body)) {
      return 'cf-challenge'
    }
    if (/error code:?\s*10(0[6-9]|1[0-2]|20)\b|cf-error-details|Attention Required! \| Cloudflare/i.test(body)) {
      return 'cf-block'
    }
  }

  if (server.includes('ddos-guard') || /ddos-guard/i.test(body.slice(0, 4096))) {
    if (status >= 400 || /check\.ddos-guard\.net|DDoS-Guard/i.test(body)) return 'ddos-guard'
  }

  if (status === 403 || status === 401) return 'forbidden' // incl. an origin's own 403 behind Cloudflare
  return 'ok'
}
