#!/usr/bin/env node
// Publishes the public packages to npm: used by the release workflow (trusted publishing) and for the first manual
// publish (docs/publishing.md). Skips versions already on npm, so re-running after a partial failure is safe.
//   node scripts/publish-npm.mjs [--dry-run] [--tag <tag>]
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const PUBLISHED = ['core', 'client']
const ALL = ['core', 'db', 'api', 'relay', 'client']

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, tag: { type: 'string' } } })
const root = join(import.meta.dirname, '..')
const sh = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim()
const die = (msg) => {
  console.error(`publish-npm: ${msg}`)
  process.exit(1)
}
const pkg = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))

const version = pkg('.').version
const wrong = ALL.filter((p) => pkg(`packages/${p}`).version !== version)
if (wrong.length) die(`versions don't match the root ${version}: ${wrong.join(', ')}`)
if (sh('git status --porcelain')) die('working tree is dirty: commit or stash first')

console.log(`building ${version}…`)
execSync('pnpm build', { cwd: root, stdio: 'inherit' })

const out = mkdtempSync(join(tmpdir(), 'reconsumet-publish-'))
let failed = false
try {
  for (const p of PUBLISHED) {
    const { name } = pkg(`packages/${p}`)
    const id = `${name}@${version}`
    try {
      let onNpm = ''
      try {
        // --prefer-online: skip npm's local cache. The registry can still answer stale for a few minutes after a
        // publish, so a conflict at publish time is handled below too.
        onNpm = execSync(`npm view ${id} version --prefer-online`, { stdio: 'pipe', encoding: 'utf8' }).trim()
      } catch {} // E404: not published yet
      if (onNpm === version) {
        console.log(`${id}: already on npm, skipped`)
        continue
      }
      // pnpm pack turns workspace:* into real versions; npm publish then publishes that exact tarball
      const tarball = sh(`pnpm pack --pack-destination "${out}"`, join(root, 'packages', p))
        .split(/\r?\n/)
        .pop()
      const flags = [values['dry-run'] && '--dry-run', values.tag && `--tag ${values.tag}`].filter(Boolean).join(' ')
      try {
        execSync(`npm publish "${tarball}" --access public ${flags}`, {
          cwd: root,
          stdio: ['ignore', 'inherit', 'pipe'],
        })
      } catch (e) {
        const err = String(e.stderr ?? '')
        process.stderr.write(err)
        // E403 "cannot publish over the previously published versions" (or EPUBLISHCONFLICT): it's already there
        if (/cannot publish over|EPUBLISHCONFLICT/i.test(err)) {
          console.log(`${id}: already on npm (registry view was stale), skipped`)
          continue
        }
        throw e
      }
      console.log(`${id}: ${values['dry-run'] ? 'dry run ok' : 'published'}`)
    } catch (e) {
      failed = true
      console.error(`${id}: FAILED — ${e.message.split('\n')[0]}`)
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
