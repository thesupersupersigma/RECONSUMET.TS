// Concurrency + rate limiting. A host gate = a semaphore plus evenly spaced start times
// (`requests` per `perMs` → one start every perMs/requests ms). Spacing instead of bursts: politer to sources.

export type Release = () => void

const abortReason = (signal: AbortSignal) => signal.reason ?? new DOMException('aborted', 'AbortError')

export class Semaphore {
  private free: number
  private readonly queue: (() => void)[] = []
  constructor(size: number) {
    this.free = Math.max(1, size)
  }

  acquire(signal?: AbortSignal): Promise<Release> {
    const release = once(() => {
      const next = this.queue.shift()
      if (next) next()
      else this.free++
    })
    if (this.free > 0) {
      this.free--
      return Promise.resolve(release)
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortReason(signal))
      const grant = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(release)
      }
      const onAbort = () => {
        const i = this.queue.indexOf(grant)
        if (i >= 0) this.queue.splice(i, 1)
        reject(abortReason(signal!))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(grant)
    })
  }
}

export class HostGate {
  private readonly sem: Semaphore
  private readonly intervalMs: number
  private nextStart = 0
  constructor(concurrency: number, rate?: { requests: number; perMs: number }) {
    this.sem = new Semaphore(concurrency)
    this.intervalMs = rate ? rate.perMs / Math.max(1, rate.requests) : 0
  }

  async acquire(signal?: AbortSignal): Promise<Release> {
    const release = await this.sem.acquire(signal)
    const now = Date.now()
    const wait = this.nextStart - now
    this.nextStart = Math.max(now, this.nextStart) + this.intervalMs // reserve the slot before waiting
    if (wait > 0) {
      try {
        await sleep(wait, signal)
      } catch (e) {
        release()
        throw e
      }
    }
    return release
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(abortReason(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function once(fn: () => void): () => void {
  let done = false
  return () => {
    if (!done) {
      done = true
      fn()
    }
  }
}
