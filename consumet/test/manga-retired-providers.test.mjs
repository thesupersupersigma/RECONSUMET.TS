// Four retired manga providers must stay retired.
//
// WHAT THIS PROTECTS. BRMangas, MangaHost, MangaReader and ReadManga are all dead upstream:
//
//   BRMangas    — brmangas.net 301s site-wide to an Indonesian gambling site; the image CDN is
//                 NXDOMAIN and the registration is in pendingDelete.
//   MangaHost   — shut down 2023-10; the domain portfolio was sold and the page title is "CLOSED".
//   MangaReader — mangareader.to has served Cloudflare 522 (origin unreachable) for ~7 months,
//                 corroborated independently by the Internet Archive.
//   ReadManga   — readmanga.app is Trellian/Above.com parked; :443 accepts TCP then RSTs.
//
// The reason this is a guarded deletion and not a tidy-up is that all four fail OPEN. They do not
// throw when the site is gone: axios silently follows the redirect into the replacement site, every
// cheerio selector then matches nothing, and `search()` resolves with `{ results: [] }` and HTTP
// 200. Any health check whose liveness criterion is "no exception was thrown" scores them healthy
// forever. That is the same silent-degradation shape that previously cost this repo a 13-agent
// investigation to diagnose. A provider that lies about being alive is worse than an absent one,
// so the fix is removal — and the thing worth pinning is the ABSENCE.
//
// This test therefore fails if a future merge re-registers any of them, whether by restoring the
// original export key, re-adding them to PROVIDERS_LIST, or resurrecting the class under a new
// name that still points at one of the four dead domains.
//
// Deliberately NOT in scope: mangapark.ts and comick.ts. MangaPark is skipped and ComicK is merely
// deprioritized; both stay registered, and are asserted present here as a positive control so this
// file cannot pass vacuously against an empty or broken MANGA export.
//
// Offline by construction: nothing here calls a provider method, so no fake axios adapter is
// needed — the test only reads the registry and the source tree. It never touches the network.
//
// Runs against dist/ — build first:
//   cd consumet && sh scripts/build-gate.sh && pnpm test:unit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('..', import.meta.url));

/** The four retirees: export key, source basename, and the dead host each one pinned. */
const RETIRED = [
  { key: 'BRMangas', file: 'brmangas', hosts: ['brmangas.net'] },
  { key: 'MangaHost', file: 'mangahost', hosts: ['mangahosted.com'] },
  { key: 'MangaReader', file: 'mangareader', hosts: ['mangareader.to'] },
  { key: 'ReadManga', file: 'readmanga', hosts: ['readmanga.app', 'rmanga.app'] },
];

const RETIRED_KEYS = RETIRED.map(r => r.key);
/** matches the class/instance `name` and `classPath` fields the retirees carried */
const RETIRED_NAME_RE = /^(BRMangas|MangaHost|MangaReader|ReadManga)$/;
const RETIRED_HOSTS = RETIRED.flatMap(r => r.hosts);

const src = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const here = p => existsSync(new URL(`../${p}`, import.meta.url));

/** Instantiate a provider and read the fields TS marks protected but that exist at runtime. */
const describeProvider = instance => ({
  name: instance?.name,
  classPath: instance?.classPath,
  ctor: instance?.constructor?.name,
  baseUrl: String(instance?.baseUrl ?? ''),
});

describe('the MANGA export surface has no retired provider', () => {
  const { MANGA } = require('../dist/index.js');
  const mangaIndex = require('../dist/providers/manga/index.js');
  const mangaDefault = mangaIndex.default ?? mangaIndex;

  test('the public MANGA export exposes none of the four keys', () => {
    const keys = Object.keys(MANGA);
    const resurrected = RETIRED_KEYS.filter(k => keys.includes(k));
    assert.deepEqual(
      resurrected,
      [],
      `retired provider(s) back on the public MANGA export: ${resurrected.join(', ')}. ` +
        `These fail OPEN (HTTP 200 + empty results, never an exception) — do not re-register them. ` +
        `Current keys: ${keys.join(', ')}`
    );
  });

  test('providers/manga/index.ts default export exposes none of the four keys', () => {
    const resurrected = RETIRED_KEYS.filter(k => k in mangaDefault);
    assert.deepEqual(resurrected, [], `re-registered in src/providers/manga/index.ts: ${resurrected.join(', ')}`);
  });

  test('the two export objects agree — no back door that skips the public surface', () => {
    assert.deepEqual(Object.keys(mangaDefault).sort(), Object.keys(MANGA).sort());
  });

  test('no exported provider is a retiree renamed — checked by name, classPath and baseUrl', () => {
    // Catches `export default { Brazilian: BRMangas }` or a straight file rename: the key changed
    // but the class still announces itself as, or still points at, a dead site.
    for (const [key, Provider] of Object.entries(MANGA)) {
      const p = describeProvider(new Provider());
      assert.doesNotMatch(String(p.name), RETIRED_NAME_RE, `MANGA.${key} reports the retired name "${p.name}"`);
      assert.doesNotMatch(
        String(p.classPath),
        /^MANGA\.(BRMangas|MangaHost|MangaReader|ReadManga)$/,
        `MANGA.${key} reports the retired classPath "${p.classPath}"`
      );
      assert.equal(
        RETIRED_HOSTS.find(h => p.baseUrl.includes(h)),
        undefined,
        `MANGA.${key} still points at the dead host in "${p.baseUrl}" — that provider cannot work, ` +
          `and it fails open rather than throwing`
      );
    }
  });

  test('the surviving export is real, and the out-of-scope providers are untouched', () => {
    // Positive control. Without this, an empty or import-broken MANGA export would satisfy every
    // absence assertion above.
    assert.ok(Object.keys(MANGA).length >= 6, `MANGA export collapsed to ${Object.keys(MANGA).length} providers`);
    for (const kept of ['ComicK', 'Mangapark']) {
      assert.ok(kept in MANGA, `${kept} was explicitly out of scope for deletion but is missing from MANGA`);
    }
  });
});

describe('PROVIDERS_LIST does not re-register a retired provider', () => {
  const { PROVIDERS_LIST } = require('../dist/utils/providers-list.js');

  test('no MANGA entry is one of the four', () => {
    const entries = PROVIDERS_LIST.MANGA.map(describeProvider);
    const bad = entries.filter(
      e =>
        RETIRED_NAME_RE.test(String(e.name)) ||
        RETIRED_NAME_RE.test(String(e.ctor)) ||
        RETIRED_HOSTS.some(h => e.baseUrl.includes(h))
    );
    assert.deepEqual(
      bad.map(e => e.name ?? e.ctor),
      [],
      `PROVIDERS_LIST.MANGA re-registered retired provider(s): ${JSON.stringify(bad)}`
    );
    assert.ok(entries.length > 0, 'PROVIDERS_LIST.MANGA is empty — the list itself broke');
  });
});

describe('the retired sources are gone from the tree, not merely unregistered', () => {
  // An unreferenced-but-present file is how a provider comes back: someone greps, finds it, and
  // wires it up again. These assertions read the source, so they fail on the offending commit even
  // before anything is built.
  for (const { file, key } of RETIRED) {
    test(`src/providers/manga/${file}.ts does not exist`, () => {
      assert.equal(here(`src/providers/manga/${file}.ts`), false, `${file}.ts is back (provider ${key})`);
    });
  }

  test('the orphaned jest suites are gone too', () => {
    // Note the inconsistent casing in test/manga/ — mangaReader.test.ts, not mangareader.test.ts.
    for (const orphan of [
      'test/manga/brmangas.test.ts',
      'test/manga/mangahost.test.ts',
      'test/manga/mangaReader.test.ts',
      'test/manga/mangareader.test.ts',
      'test/manga/readmanga.test.ts',
    ]) {
      assert.equal(here(orphan), false, `${orphan} exists but its provider does not — that is a TS2307 waiting`);
    }
  });

  test('neither registry file mentions them in source', () => {
    for (const file of ['src/providers/manga/index.ts', 'src/utils/providers-list.ts']) {
      const text = src(file);
      for (const { key, file: base } of RETIRED) {
        assert.doesNotMatch(text, new RegExp(`\\b${key}\\b`), `${file} still names ${key}`);
        assert.doesNotMatch(text, new RegExp(`['"\\./]${base}['"]`), `${file} still imports ./${base}`);
      }
    }
  });
});

describe('repo path sanity', () => {
  test('the test is resolving the repo it thinks it is', () => {
    // If `repo` ever pointed somewhere else, every existsSync() above would pass for the wrong
    // reason. Anchor on a file that must exist.
    assert.ok(existsSync(`${repo}package.json`), `expected consumet/package.json under ${repo}`);
    assert.ok(here('src/providers/manga/mangadex.ts'), 'src/providers/manga/ is not where this test thinks');
  });
});
