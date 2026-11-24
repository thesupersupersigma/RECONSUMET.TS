// The data dir (RECONSUMET_DATA_DIR, default ./data, gitignored): catalog, caches, mappings, overrides.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export function dataDir(): string {
  return resolve(process.env.RECONSUMET_DATA_DIR || 'data')
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

/** Write via a temp file + rename so a crash never leaves half a file. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, path)
}

/** JSON values on disk with a TTL, one file per key. */
export class DiskCache {
  readonly dir: string
  constructor(dir: string) {
    this.dir = dir
  }

  private path(key: string) {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`)
  }

  async get<T>(key: string): Promise<T | undefined> {
    const hit = await readJson<{ expires: number; value: T }>(this.path(key)).catch(() => undefined)
    if (!hit) return undefined
    if (hit.expires < Date.now()) {
      await rm(this.path(key), { force: true })
      return undefined
    }
    return hit.value
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    await writeJson(this.path(key), { key, expires: Date.now() + ttlMs, value })
  }

  /** get, or compute + store. */
  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key)
    if (hit !== undefined) return hit
    const value = await fn()
    await this.set(key, value, ttlMs)
    return value
  }
}
