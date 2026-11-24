# @reconsumet/core

[![npm](https://img.shields.io/npm/v/@reconsumet/core)](https://www.npmjs.com/package/@reconsumet/core)
[![Discord](https://img.shields.io/badge/discord-join-5865F2)](https://discord.gg/trvtVNWzaf)

The RECONSUMΣT.TS scraping library: anime sources (Re:Anime, AniZone), a browser-like fetch layer, the anime catalog,
an AniList client and AniList → source season matching. Use it on its own, the way consumet was used; the
[RECONSUMΣT.TS API](https://github.com/thesupersupersigma/RECONSUMET.TS) is built on it. Node 26 or newer.

```sh
npm i @reconsumet/core
```

```ts
import { createSources } from '@reconsumet/core'

const { fetcher, sources } = createSources()
const reanime = sources.get('reanime')!
const [hit] = await reanime.search('frieren')
const show = await reanime.getShow(hit!.id)
const ep1 = show.episodes.find((e) => e.number === 1)!
const { servers } = await reanime.getStreams(ep1.id, { audio: 'sub' })
console.log(servers[0]?.streams[0]?.url) // send the stream's `headers` along when you fetch it
await fetcher.close()
```

There is also a CLI: `npx @reconsumet/core --help` (`search`, `match`, `streams`, `catalog update`, …).

Docs: [sources and matching](https://github.com/thesupersupersigma/RECONSUMET.TS/blob/master/docs/sources.md),
[catalog + AniList](https://github.com/thesupersupersigma/RECONSUMET.TS/blob/master/docs/catalog.md),
[fetch layer](https://github.com/thesupersupersigma/RECONSUMET.TS/blob/master/docs/fetch.md).

GPL-3.0-or-later.
