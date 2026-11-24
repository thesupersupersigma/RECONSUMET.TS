#!/usr/bin/env node
// Admin commands against DATABASE_URL: migrations and API keys.
import { connect, createApiKey, listApiKeys, migrate, revokeApiKey } from '@reconsumet/db'

const HELP = `reconsumet-api — admin commands (uses DATABASE_URL)

  migrate                          apply database migrations (the API also does this on start)
  keys create <name> [perMinute]   new API key; the key is printed once, only its hash is stored
  keys list
  keys revoke <id>`

const [cmd, sub, ...rest] = process.argv.slice(2)
if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(HELP)
  process.exit(0)
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const db = connect(process.env.DATABASE_URL, { max: 2 }) // withLock reserves one connection
try {
  if (cmd === 'migrate') {
    await migrate(db)
    console.log('migrations applied')
  } else if (cmd === 'keys' && sub === 'create' && rest[0]) {
    const limit = rest[1] ? Number(rest[1]) : null
    if (limit !== null && !(limit > 0)) throw new Error('perMinute must be a positive number')
    const { id, key } = await createApiKey(db, rest[0], limit)
    console.log(`id ${id}\n${key}\n(store it now: it can't be shown again)`)
  } else if (cmd === 'keys' && sub === 'list') {
    for (const k of await listApiKeys(db)) {
      const used = k.lastUsedAt?.toISOString() ?? 'never'
      console.log(`${k.id}\t${k.name}\t${k.rateLimit ?? 'default'}/min\tused ${used}${k.revoked ? '\tREVOKED' : ''}`)
    }
  } else if (cmd === 'keys' && sub === 'revoke' && rest[0]) {
    console.log((await revokeApiKey(db, Number(rest[0]))) ? 'revoked' : 'no such key')
  } else {
    console.error(HELP)
    process.exitCode = 2
  }
} finally {
  await db.close()
}
