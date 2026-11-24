# @reconsumet/client

[![npm](https://img.shields.io/npm/v/@reconsumet/client)](https://www.npmjs.com/package/@reconsumet/client)
[![Discord](https://img.shields.io/badge/discord-join-5865F2)](https://discord.gg/trvtVNWzaf)

Typed client for a [RECONSUMΣT.TS](https://github.com/thesupersupersigma/RECONSUMET.TS) API server. Routes, parameters
and responses are typed from the API itself (Hono RPC). Its only dependency is `hono`.

```sh
npm i @reconsumet/client
```

```ts
import { createClient, type StreamsT } from '@reconsumet/client'

// Server-side only: the API key must never reach a browser.
const api = createClient('https://api.example.com', { apiKey: process.env.RECONSUMET_API_KEY })

const hits = await (await api.v1.search.$get({ query: { q: 'frieren' } })).json()
const res = await api.v1.anime[':anilistId'].episodes[':episode'].streams.$get({
  param: { anilistId: '154587', episode: '1' },
  query: { audio: 'sub' },
})
if (res.ok) {
  const streams: StreamsT = await res.json()
  console.log(streams.servers[0]?.streams[0]?.url)
}
```

Use the client version that matches your API server's version. Endpoint reference:
[docs/api.md](https://github.com/thesupersupersigma/RECONSUMET.TS/blob/master/docs/api.md).

GPL-3.0-or-later.
