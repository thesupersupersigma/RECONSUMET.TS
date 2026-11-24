// Entry point: node dist/main.js (config from the environment, see config.ts).
import { serve } from '@hono/node-server'
import { loadConfig } from './config.ts'
import { createRelay } from './relay.ts'

const config = loadConfig()
const relay = createRelay(config)
const server = serve({ fetch: relay.app.fetch, port: config.port }, (info) =>
  console.log(`relay listening on :${info.port}`),
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    // stop accepting, let running streams finish (Docker kills us after its grace period anyway)
    server.close(() => void relay.close().then(() => process.exit(0)))
  })
}
