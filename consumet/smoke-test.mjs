// Empirical smoke test for @consumet/extensions anime providers.
// For each provider: search -> fetchAnimeInfo -> fetchEpisodeSources.
// Prints a PASS/FAIL matrix so we know what actually works today.

import pkg from './dist/index.js';
const { ANIME } = pkg;

const QUERY = process.argv[2] || 'naruto';
const STEP_TIMEOUT = 30000;

const withTimeout = (p, ms, label) =>
  Promise.race([
    Promise.resolve().then(() => p),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout>${ms}ms @ ${label}`)), ms)),
  ]);

const short = (e) => (e?.message || String(e)).replace(/\s+/g, ' ').slice(0, 90);

async function testProvider(name, Provider) {
  const row = { name, search: '-', info: '-', sources: '-', subs: '-', note: '' };
  let inst;
  try {
    inst = new Provider();
  } catch (e) {
    row.note = 'ctor: ' + short(e);
    return row;
  }
  // 1) search
  let results;
  try {
    const r = await withTimeout(inst.search(QUERY), STEP_TIMEOUT, 'search');
    results = r?.results || [];
    row.search = results.length ? `${results.length}` : '0';
    if (!results.length) { row.note = 'no results'; return row; }
  } catch (e) {
    row.search = 'ERR';
    row.note = 'search: ' + short(e);
    return row;
  }
  // 2) info
  let info;
  try {
    info = await withTimeout(inst.fetchAnimeInfo(results[0].id), STEP_TIMEOUT, 'info');
    const eps = info?.episodes || [];
    row.info = eps.length ? `${eps.length}ep` : '0ep';
    if (!eps.length) { row.note = 'no episodes'; return row; }
  } catch (e) {
    row.info = 'ERR';
    row.note = 'info: ' + short(e);
    return row;
  }
  // 3) sources
  try {
    const epId = info.episodes[0].id;
    const src = await withTimeout(inst.fetchEpisodeSources(epId), STEP_TIMEOUT, 'sources');
    const sources = src?.sources || [];
    const subs = src?.subtitles || [];
    row.sources = sources.length ? `${sources.length}` : '0';
    row.subs = `${subs.length}`;
    if (!sources.length) row.note = 'no playable sources';
  } catch (e) {
    row.sources = 'ERR';
    row.note = 'sources: ' + short(e);
  }
  return row;
}

const SKIP = new Set(['Crunchyroll', 'Bilibili']); // require cookies/auth

const rows = [];
for (const [name, Provider] of Object.entries(ANIME)) {
  if (SKIP.has(name)) { rows.push({ name, search: 'skip', info: '-', sources: '-', subs: '-', note: 'needs auth/cookie' }); continue; }
  process.stderr.write(`testing ${name}...\n`);
  rows.push(await testProvider(name, Provider));
}

const pad = (s, n) => String(s).padEnd(n);
console.log('\n' + pad('PROVIDER', 14) + pad('SEARCH', 8) + pad('INFO', 8) + pad('SRC', 6) + pad('SUBS', 6) + 'NOTE');
console.log('-'.repeat(80));
for (const r of rows) {
  console.log(pad(r.name, 14) + pad(r.search, 8) + pad(r.info, 8) + pad(r.sources, 6) + pad(r.subs, 6) + r.note);
}
const working = rows.filter((r) => /^\d+$/.test(r.sources) && Number(r.sources) > 0);
console.log('-'.repeat(80));
console.log(`WORKING end-to-end (playable sources): ${working.length} -> ${working.map((r) => r.name).join(', ') || 'NONE'}`);
