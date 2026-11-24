// Per-IP stream limit and bandwidth shaping (per IP + global), so one viewer can't eat the home server's upload.
import { setTimeout as sleep } from 'node:timers/promises'

/** Largest piece sent per bucket check, so a big upstream chunk can't burst past the rate. */
const CHUNK = 64 * 1024
const IDLE_MS = 60_000

/** Token bucket in bytes, refilled continuously, burst = 1 s of rate. */
export class Bucket {
  readonly rate: number
  private tokens: number
  private last: number

  constructor(bytesPerSec: number, now: number) {
    this.rate = bytesPerSec
    this.tokens = bytesPerSec
    this.last = now
  }

  /** Reserves `n` bytes (the bucket may go into debt) and returns how many ms to wait before sending them. */
  take(n: number, now: number): number {
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) * this.rate) / 1000)
    this.last = now
    this.tokens -= n
    return this.tokens >= 0 ? 0 : (-this.tokens / this.rate) * 1000
  }
}

interface Peer {
  streams: number
  bucket: Bucket
  seen: number
}

export interface LimitOptions {
  maxStreamsPerIp: number
  ipBytesPerSec: number
  /** Unset = no global ceiling. */
  globalBytesPerSec?: number
}

export function createLimits(opts: LimitOptions) {
  const peers = new Map<string, Peer>()
  const all = opts.globalBytesPerSec ? new Bucket(opts.globalBytesPerSec, performance.now()) : null
  const stats = { bytesOut: 0, activeStreams: 0, throttledMs: 0 }
  let swept = performance.now()

  const peer = (ip: string): Peer => {
    const now = performance.now()
    if (now - swept > IDLE_MS) {
      swept = now
      // an idle minute means the bucket is full again, so forgetting the peer loses nothing
      for (const [k, p] of peers) if (!p.streams && now - p.seen > IDLE_MS) peers.delete(k)
    }
    let p = peers.get(ip)
    if (!p) {
      p = { streams: 0, bucket: new Bucket(opts.ipBytesPerSec, now), seen: now }
      peers.set(ip, p)
    }
    p.seen = now
    return p
  }

  return {
    stats,

    /** Claims a stream slot for `ip`: a release function (safe to call twice), or null when the IP is at its limit. */
    open(ip: string): (() => void) | null {
      const p = peer(ip)
      if (p.streams >= opts.maxStreamsPerIp) return null
      p.streams++
      stats.activeStreams++
      let released = false
      return () => {
        if (released) return
        released = true
        p.streams--
        stats.activeStreams--
        p.seen = performance.now()
      }
    },

    /** Bytes sent outside pipe() (playlists). */
    count(n: number) {
      stats.bytesOut += n
    },

    /** Throttles and counts `body`; calls `release` once it ends, fails or the client cancels it. */
    pipe(
      ip: string,
      body: ReadableStream<Uint8Array>,
      release: () => void,
      onError: (e: unknown) => void = () => {},
    ): ReadableStream<Uint8Array> {
      const bucket = peer(ip).bucket
      const reader = body.getReader()
      let ended = false
      const end = () => {
        ended = true
        release()
      }
      return new ReadableStream<Uint8Array>(
        {
          async pull(c) {
            try {
              const { done, value } = await reader.read()
              if (ended) return
              if (done) {
                end()
                c.close()
                return
              }
              for (let i = 0; i < value.byteLength; i += CHUNK) {
                const part = value.subarray(i, i + CHUNK)
                const now = performance.now()
                const wait = Math.max(bucket.take(part.byteLength, now), all?.take(part.byteLength, now) ?? 0)
                if (wait > 0) {
                  stats.throttledMs += wait
                  await sleep(wait)
                  if (ended) return
                }
                stats.bytesOut += part.byteLength
                c.enqueue(part)
              }
            } catch (e) {
              if (ended) return
              end()
              onError(e)
              c.error(e)
            }
          },
          cancel(reason) {
            end()
            return reader.cancel(reason)
          },
        },
        { highWaterMark: 0 }, // backpressure: read upstream only as fast as the client takes it
      )
    },
  }
}
