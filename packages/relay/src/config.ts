// Relay settings, from the environment:
// RELAY_SECRET              required; the secret the API seals tokens with (at least 32 characters)
// RELAY_SECRET_PREVIOUS     optional; the previous secret, still accepted while a rotation is in progress
// RELAY_ALLOWED_ORIGINS     comma list of site origins (https://example.org) allowed to call the relay from a browser
// TRUSTED_PROXIES           comma list of IPs/CIDRs whose X-Forwarded-For is believed
// PORT                      listen port, default 8081
// RELAY_METRICS_TOKEN       optional; bearer token for /metrics, which is 404 without it
// RELAY_MAX_STREAMS_PER_IP  bodies streamed to one client IP at once, default 6
// RELAY_IP_MBPS             bandwidth ceiling per client IP, megabits/s, default 12
// RELAY_GLOBAL_MBPS         bandwidth ceiling for the whole relay, megabits/s, default 32
// RELAY_CHILD_TTL_MIN       lifetime of the tokens minted while rewriting a playlist, minutes, default 360
// RELAY_MAX_PLAYLIST_LINES  longer playlists are refused, default 20000
// RELAY_MAX_SEGMENT_MB      size cap for segments and init segments, MiB, default 64

export interface RelayConfig {
  /** Current secret first (used to seal child tokens), then the previous one. */
  secrets: string[]
  allowedOrigins: string[]
  trustedProxies: string
  port: number
  metricsToken: string | undefined
  maxStreamsPerIp: number
  ipBytesPerSec: number
  globalBytesPerSec: number
  childTtlMs: number
  maxPlaylistLines: number
  maxSegmentBytes: number
}

type Env = Record<string, string | undefined>

function num(env: Env, name: string, fallback: number, integer = true): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} must be a positive ${integer ? 'integer' : 'number'}, got "${raw}"`)
  }
  return n
}

const list = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const mbps = (n: number) => (n * 1_000_000) / 8

export function loadConfig(env: Env = process.env): RelayConfig {
  const secret = env.RELAY_SECRET?.trim()
  if (!secret) throw new Error('RELAY_SECRET is required (the same secret the API seals relay tokens with)')
  if (secret.length < 32) throw new Error('RELAY_SECRET must be at least 32 characters')
  const previous = env.RELAY_SECRET_PREVIOUS?.trim()
  const port = num(env, 'PORT', 8081)
  if (port > 65535) throw new Error(`PORT must be at most 65535, got ${port}`)
  return {
    secrets: previous ? [secret, previous] : [secret],
    allowedOrigins: list(env.RELAY_ALLOWED_ORIGINS),
    trustedProxies: env.TRUSTED_PROXIES ?? '',
    port,
    metricsToken: env.RELAY_METRICS_TOKEN?.trim() || undefined,
    maxStreamsPerIp: num(env, 'RELAY_MAX_STREAMS_PER_IP', 6),
    ipBytesPerSec: mbps(num(env, 'RELAY_IP_MBPS', 12, false)),
    globalBytesPerSec: mbps(num(env, 'RELAY_GLOBAL_MBPS', 32, false)),
    childTtlMs: num(env, 'RELAY_CHILD_TTL_MIN', 360) * 60_000,
    maxPlaylistLines: num(env, 'RELAY_MAX_PLAYLIST_LINES', 20_000),
    maxSegmentBytes: num(env, 'RELAY_MAX_SEGMENT_MB', 64) * 1024 * 1024,
  }
}
