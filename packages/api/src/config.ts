// Every setting comes from the environment (docs/deploy.md explains each one). Public URLs are config, never the
// request's Host header.
export interface ApiConfig {
  databaseUrl: string
  port: number
  /** Where this API is reachable from outside (OpenAPI `servers`). */
  publicUrl: string
  /** Base URL of the relay service; stream URLs are `${relayPublicUrl}/r/<token>.<ext>`. */
  relayPublicUrl: string
  relaySecret: string
  /** Lifetime of the top-level playlist/subtitle tokens the API hands out. */
  relayTokenTtlMs: number
  /** False once the relay runs on another IP: Re:Anime HD-1 (IP-locked) streams are dropped then. */
  relaySharesEgress: boolean
  requireKeyForStreams: boolean
  trustedProxies: string
  ipPerMin: number
  keyPerMin: number
  jobs: boolean
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : /^(1|true|yes)$/i.test(v))
const num = (env: NodeJS.ProcessEnv, name: string, dflt: number) => {
  const v = env[name]
  if (v === undefined || v === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${v}"`)
  return n
}
const url = (env: NodeJS.ProcessEnv, name: string) => {
  const v = env[name]
  if (!v) throw new Error(`${name} is required`)
  try {
    return new URL(v).href.replace(/\/$/, '')
  } catch {
    throw new Error(`${name} must be an absolute URL, got "${v}"`)
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const relaySecret = env.RELAY_SECRET ?? ''
  if (relaySecret.length < 32) throw new Error('RELAY_SECRET is required (at least 32 characters, see docs/deploy.md)')
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  return {
    databaseUrl: env.DATABASE_URL,
    port: num(env, 'PORT', 8080),
    publicUrl: url(env, 'PUBLIC_URL'),
    relayPublicUrl: url(env, 'RELAY_PUBLIC_URL'),
    relaySecret,
    relayTokenTtlMs: num(env, 'RELAY_TOKEN_TTL_MIN', 10) * 60_000,
    relaySharesEgress: bool(env.RELAY_SHARES_EGRESS_WITH_API, true),
    requireKeyForStreams: bool(env.REQUIRE_KEY_FOR_STREAMS, true),
    trustedProxies: env.TRUSTED_PROXIES ?? '',
    ipPerMin: num(env, 'RATE_LIMIT_IP_PER_MIN', 60),
    keyPerMin: num(env, 'RATE_LIMIT_KEY_PER_MIN', 600),
    jobs: bool(env.JOBS_ENABLED, true),
  }
}
