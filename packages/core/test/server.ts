import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** Local HTTP server on 127.0.0.1; tests register handlers by path. */
export async function startServer() {
  const routes = new Map<string, Handler>()
  const hits = new Map<string, number>()
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    hits.set(path, (hits.get(path) ?? 0) + 1)
    const h = routes.get(path)
    if (h) h(req, res)
    else res.writeHead(404).end('no route')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    url: (path: string, host = '127.0.0.1') => `http://${host}:${port}${path}`,
    route: (path: string, h: Handler) => routes.set(path, h),
    hits: (path: string) => hits.get(path) ?? 0,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
