import { FetchError, FetchNetworkError, TooLargeError } from './errors.ts'

type Done = (bytes: number, error?: unknown) => void

/**
 * A response body, readable once: as text / JSON / bytes, or as a stream (the proxy pipes video through it).
 * Every way of reading enforces the size cap. When it ends (read fully, cancelled or failed), the request's
 * concurrency slot is released and its event is emitted, so always read or cancel() a body.
 */
export class Body {
  private used = false
  private finished = false
  private count = 0
  private readonly source: ReadableStream<Uint8Array> | null
  private readonly url: string
  private readonly maxBytes: number
  private readonly done: Done

  constructor(source: ReadableStream<Uint8Array> | null, url: string, maxBytes: number, done: Done = () => {}) {
    this.source = source
    this.url = url
    this.maxBytes = maxBytes
    this.done = done
  }

  static from(bytes: Uint8Array, url: string, maxBytes: number, done?: Done): Body {
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        if (bytes.byteLength) c.enqueue(bytes)
        c.close()
      },
    })
    return new Body(source, url, maxBytes, done)
  }

  /** True once text()/json()/bytes()/stream()/cancel() was called. */
  get bodyUsed(): boolean {
    return this.used
  }

  /** Bytes read so far. */
  get bytesRead(): number {
    return this.count
  }

  stream(): ReadableStream<Uint8Array> {
    this.take()
    const source = this.source
    if (!source) {
      this.finish()
      return new ReadableStream({ start: (c) => c.close() })
    }
    const reader = source.getReader()
    return new ReadableStream<Uint8Array>(
      {
        pull: async (c) => {
          try {
            const { done, value } = await reader.read()
            if (done) {
              c.close()
              this.finish()
              return
            }
            this.count += value.byteLength
            if (this.count > this.maxBytes) {
              const e = new TooLargeError(this.url, this.maxBytes)
              reader.cancel(e).catch(() => {})
              c.error(e)
              this.finish(e)
              return
            }
            c.enqueue(value)
          } catch (e) {
            const err =
              e instanceof FetchError
                ? e
                : new FetchNetworkError(`body read failed: ${this.url}`, this.url, { cause: e })
            c.error(err)
            this.finish(err)
          }
        },
        cancel: (reason) => {
          this.finish()
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 }, // pull only when the consumer wants more: backpressure reaches the socket
    )
  }

  async bytes(): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    for await (const chunk of this.stream()) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes())
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T
  }

  /** Discard the body without reading it. */
  async cancel(): Promise<void> {
    if (this.used) return
    this.used = true
    this.finish()
    await this.source?.cancel().catch(() => {})
  }

  private take() {
    if (this.used) throw new TypeError(`body already used: ${this.url}`)
    this.used = true
  }

  private finish(error?: unknown) {
    if (this.finished) return
    this.finished = true
    this.done(this.count, error)
  }
}
