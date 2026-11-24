// Acceptance test for the published client: pack it, install the tarball with plain npm in a temp project outside the
// workspace, and typecheck real calls. Proves the .d.ts is self-contained and typed (not `any`), and that installing
// the client doesn't pull in the API server. Run after `pnpm build`.
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pkgDir = join(import.meta.dirname, '..')
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })

if (!existsSync(join(pkgDir, 'dist/index.d.ts'))) throw new Error('build first: pnpm build')
const tmp = mkdtempSync(join(tmpdir(), 'reconsumet-client-pack-'))
try {
  const tarball = run(`pnpm pack --pack-destination "${tmp}"`, pkgDir).trim().split(/\r?\n/).pop()
  console.log(`packed ${tarball}`)
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'pack-test', private: true, type: 'module' }))
  run(`npm install --no-audit --no-fund --loglevel=error "${tarball}" typescript@^7`, tmp)

  const leaked = ['api', 'db', 'core', 'relay'].filter((p) => existsSync(join(tmp, 'node_modules/@reconsumet', p)))
  if (leaked.length) throw new Error(`installing the client pulled in @reconsumet/${leaked.join(', ')}`)
  console.log(
    `node_modules: ${readdirSync(join(tmp, 'node_modules'))
      .filter((d) => !d.startsWith('.'))
      .join(', ')}`,
  )

  writeFileSync(
    join(tmp, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2024',
        lib: ['es2024', 'dom'],
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        noEmit: true,
        skipLibCheck: false, // check the client's own .d.ts too: an unresolved import there must fail
      },
      include: ['check.ts'],
    }),
  )
  writeFileSync(
    join(tmp, 'check.ts'),
    `import { createClient, type AnimeT, type EpisodesT, type StreamsT } from '@reconsumet/client'

const api = createClient('https://api.example.com', { apiKey: 'k' })

const search = await api.v1.search.$get({ query: { q: 'frieren' } })
if (search.ok) {
  const hits = await search.json()
  const title: string = hits[0]!.title
  // @ts-expect-error no such field
  hits[0]!.nope
}

const anime = await api.v1.anime[':anilistId'].$get({ param: { anilistId: '1' } })
if (anime.ok) {
  const a: AnimeT = await anime.json()
  const romaji: string | null = a.title.romaji
  // @ts-expect-error romaji may be null
  const bad: string = a.title.romaji
}

const eps = await api.v1.anime[':anilistId'].episodes.$get({ param: { anilistId: '1' }, query: {} })
if (eps.ok) {
  const e: EpisodesT = await eps.json()
  const n: number = e.episodes[0]!.number
  // @ts-expect-error number, not string
  const s: string = e.episodes[0]!.number
}

const res = await api.v1.anime[':anilistId'].episodes[':episode'].streams.$get({
  param: { anilistId: '1', episode: '1' },
  query: { audio: 'sub' },
})
if (res.ok) {
  const st: StreamsT = await res.json()
  const url: string = st.servers[0]!.streams[0]!.url
  // @ts-expect-error streams have no 'nope'
  st.servers[0]!.streams[0]!.nope
}

// @ts-expect-error audio must be sub | dub
api.v1.anime[':anilistId'].episodes[':episode'].streams.$get({ param: { anilistId: '1', episode: '1' }, query: { audio: 'x' } })
// @ts-expect-error no such route
api.v1.nope
`,
  )
  run('npx --no-install tsc -p .', tmp)
  console.log('typecheck ok: results are typed, wrong fields fail')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
