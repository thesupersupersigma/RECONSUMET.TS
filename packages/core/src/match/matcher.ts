// AniList ID → source show + episode offset (v1's two-tier idea, rebuilt):
//  tier 1: search the source with the AniList titles, rank candidates by normalized title similarity
//  tier 2: verify year, format, episode count, season/part numbers; reject contradictions
//  offsets: when a candidate covers more episodes than the AniList entry, walk the PREQUEL chain — if the candidate
//  is really the prequel's show continuing (split cour / continuing numbering), return the offset and range.
// Below the threshold the answer is "no match", never a guess.
import type { AniListMedia } from '../anilist/client.ts'
import type { CatalogStore } from '../catalog/types.ts'
import type { SearchResult, Source } from '../sources/types.ts'
import { normalizeTitle, parseTitle, similarity, type TitleInfo } from './title.ts'

export const THRESHOLD = 0.65

export interface MatchResult {
  sourceId: string
  anilistId: number
  /** null = no match on this source. */
  showId: string | null
  title?: string
  confidence: number
  /** Source episode = AniList episode + offset. */
  episodeOffset: number
  /** Source episodes covering this AniList entry, when the source show is longer than it. */
  episodeRange?: [number, number]
  reasons: string[]
}

export interface MatchDeps {
  media(id: number): Promise<AniListMedia | null>
  catalog: Pick<CatalogStore, 'get'>
}

/** One side of a comparison: an AniList entry (with catalog synonyms) or a source candidate. */
interface Ref {
  titles: string[]
  parsed: TitleInfo[]
  full: Set<string> // normalized raw titles incl. "(2023)" markers
  season?: number
  part?: number
  group: string // series | movie | extra | unknown
  year?: number
  episodes?: number
}

const GROUP: Record<string, string> = {
  TV: 'series',
  TV_SHORT: 'series',
  ONA: 'series',
  MOVIE: 'movie',
  OVA: 'extra',
  SPECIAL: 'extra',
  MUSIC: 'extra',
}

function ref(titles: string[], format: string | undefined, year?: number | null, episodes?: number | null): Ref {
  const clean = [...new Set(titles.filter((t) => t && /[\p{L}\p{N}]/u.test(t)))]
  const parsed = clean.map(parseTitle)
  const pick = (k: 'season' | 'part') => parsed.map((p) => p[k]).find((v) => v !== undefined)
  return {
    titles: clean,
    parsed,
    full: new Set(clean.map(normalizeTitle)),
    season: pick('season'),
    part: pick('part'),
    group: GROUP[format ?? ''] ?? 'unknown',
    year: year || undefined,
    episodes: episodes || undefined,
  }
}

async function mediaRef(m: AniListMedia, deps: MatchDeps): Promise<Ref> {
  const entry = await deps.catalog.get({ anilistId: m.id })
  // season/part markers come from the main titles only; synonyms are noisy ("Jujutsu Kaisen" on the S2 entry)
  const main = ref([m.title.romaji, m.title.english].filter((t): t is string => !!t), m.format ?? undefined)
  const all = ref(
    [m.title.romaji, m.title.english, ...m.synonyms, ...(entry?.synonyms ?? [])].filter((t): t is string => !!t),
    m.format ?? undefined,
    m.seasonYear ?? m.startDate.year,
    // an airing show's count in the (months-old) offline database is stale: only trust it for finished shows
    m.episodes ?? (m.status === 'FINISHED' ? entry?.episodes : undefined),
  )
  return { ...all, season: main.season, part: main.part }
}

function candRef(c: SearchResult): Ref {
  return ref([c.title, ...c.altTitles], c.type, c.year, c.episodes)
}

/** `exact` = length of the longest title both sides share verbatim (normalized), 0 if none. */
function titleSim(a: Ref, b: Ref): { sim: number; exact: number } {
  let sim = 0
  for (const x of a.parsed) for (const y of b.parsed) sim = Math.max(sim, similarity(x.base, y.base))
  let exact = 0
  for (const t of a.full) if (b.full.has(t)) exact = Math.max(exact, t.length)
  return { sim, exact }
}

interface Scored {
  confidence: number
  offset: number
  range?: [number, number]
  reasons: string[]
  /** Tie-break between equal scores: the longer shared exact title is the more specific match. */
  specificity: number
}

/** Tier 2 for a direct match (offset 0). null = contradiction. */
function verifyDirect(t: Ref, c: Ref, targetFinished: boolean): Scored | null {
  const { sim, exact } = titleSim(t, c)
  const reasons = [exact ? 'exact title' : `title ${sim.toFixed(2)}`]
  let conf = exact ? Math.max(sim, 0.9) : sim
  if (t.season !== undefined && c.season !== undefined && t.season !== c.season) return null
  if (t.part !== undefined && c.part !== undefined && t.part !== c.part) return null
  if ((t.group === 'movie') !== (c.group === 'movie') && t.group !== 'unknown' && c.group !== 'unknown') return null
  if (t.group !== c.group && t.group !== 'unknown' && c.group !== 'unknown') {
    conf -= 0.2
    reasons.push(`format ${t.group}≠${c.group}`)
  }
  if (t.year && c.year) {
    const d = Math.abs(t.year - c.year)
    if (d >= 2) return null
    conf += d === 0 ? 0.1 : -0.1
    reasons.push(d === 0 ? 'same year' : 'year ±1')
  }
  if (t.episodes && c.episodes) {
    if (t.episodes === c.episodes) {
      conf += 0.1
      reasons.push('same episode count')
    } else if (c.episodes > t.episodes || targetFinished) {
      conf -= 0.3
      reasons.push(`episodes ${t.episodes}≠${c.episodes}`)
    }
  }
  return { confidence: conf, offset: 0, reasons, specificity: exact }
}

interface Linked {
  ref: Ref
  title: string
}

/**
 * The candidate is one source show covering a run of consecutive AniList entries (split cours, or a source that keeps
 * numbering): [k prequels…, target, j sequels…]. It must start in the first entry's year and its episode count must
 * equal the run's sum (or, when the run ends at the target, at least hold it). Offset = the k prequels' episodes.
 */
function verifyRun(t: Ref, pre: Linked[], seq: Linked[], c: Ref): Scored | null {
  if (!t.episodes) return null
  let acc = 0
  for (let k = 0; k <= pre.length; k++) {
    if (k > 0) {
      const p = pre[k - 1] as Linked
      if (!p.ref.episodes || p.ref.group !== 'series') return null
      acc += p.ref.episodes
    }
    const first = k === 0 ? { ref: t, title: 'itself' } : (pre[k - 1] as Linked)
    if (c.episodes && acc + t.episodes > c.episodes) return null
    if (first.ref.year && c.year && first.ref.year !== c.year) continue
    let sum = acc + t.episodes
    let fit = c.episodes === sum ? `${acc ? `${acc}+` : ''}${t.episodes}` : ''
    for (const q of seq) {
      if (fit || !c.episodes || !q.ref.episodes || q.ref.group !== 'series') break
      sum += q.ref.episodes
      if (sum === c.episodes) fit = `${acc ? `${acc}+` : ''}${t.episodes}+sequels=${c.episodes}`
    }
    if (k === 0 && !fit.includes('sequels')) continue // a plain direct match is verifyDirect's job
    if (c.episodes && !fit && k > 0 && c.episodes < sum) continue
    const { sim, exact } = titleSim(first.ref, c)
    const reasons = [
      k ? `continues "${first.title}" (${exact ? 'exact title' : `title ${sim.toFixed(2)}`})` : `title ${sim.toFixed(2)}`,
      `offset ${acc}`,
    ]
    if (fit) reasons.push(`episodes add up (${fit})`)
    const conf = (exact ? Math.max(sim, 0.9) : sim) + (fit ? 0.1 : 0)
    return { confidence: conf, offset: acc, range: [acc + 1, acc + t.episodes], reasons, specificity: exact }
  }
  return null
}

/** Raw titles with season/part/year structure removed: broad queries that return the whole franchise. */
export function stripStructure(title: string): string {
  return title
    .replace(/\(\d{4}\)\s*$/, '')
    .replace(/\s+(?:OVA|OAD|ONA|TV|Specials?|Movie)\s*$/i, '')
    .replace(/\b(?:\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|final)\s+season\b.*$/i, '')
    .replace(/\b(?:season|part|cour)\s*\d{1,2}\b.*$/i, '')
    .replace(/[\s:.\-–]+$/, '')
    .trim()
}

/**
 * Search queries, broad first: the romaji title without season/part markers, its franchise part before a colon
 * ("Gintama.: Porori-hen" → "Gintama."), an AniDB-style "(year)" synonym (what AniDB-named sources call it), then the
 * full romaji and English titles.
 */
export function queriesFor(m: AniListMedia, synonyms: string[] = [], max = 4): string[] {
  const romaji = m.title.romaji ?? ''
  const english = m.title.english ?? ''
  const prefix = (t: string) => t.split(/:\s|\s[-–]\s/)[0] ?? ''
  const anidb = synonyms.find((s) => /\S \(\d{4}\)$/.test(s) && /^[\x20-\x7e]+$/.test(s)) ?? ''
  const out: string[] = []
  for (const q of [stripStructure(romaji), prefix(romaji), anidb, romaji, stripStructure(english), english]) {
    if (q.trim().length >= 2 && !out.some((o) => normalizeTitle(o) === normalizeTitle(q))) out.push(q.trim())
  }
  return out.slice(0, max)
}

/** Nearest first. Each step is one AniList lookup (cached), so the depth stays small. */
async function relationChain(m: AniListMedia, deps: MatchDeps, type: 'PREQUEL' | 'SEQUEL', depth: number) {
  const chain: Linked[] = []
  let cur: AniListMedia | null = m
  for (let i = 0; i < depth && cur; i++) {
    const edge = cur.relations?.edges.find((e) => e.relationType === type && e.node.type === 'ANIME')
    if (!edge) break
    cur = await deps.media(edge.node.id)
    if (!cur) break
    chain.push({ ref: await mediaRef(cur, deps), title: cur.title.romaji ?? String(cur.id) })
  }
  return chain
}

export async function matchSource(
  anilistId: number,
  source: Pick<Source, 'id' | 'search'>,
  deps: MatchDeps,
  threshold = THRESHOLD,
): Promise<MatchResult> {
  const m = await deps.media(anilistId)
  if (!m) throw new Error(`AniList has no anime ${anilistId}`)
  const target = await mediaRef(m, deps)
  const none = (reasons: string[]): MatchResult => ({
    sourceId: source.id,
    anilistId,
    showId: null,
    confidence: 0,
    episodeOffset: 0,
    reasons,
  })

  let chains: { pre: Linked[]; seq: Linked[] } | undefined
  let best: (Scored & { cand: SearchResult }) | undefined
  const seen = new Set<string>()
  const tried: string[] = []
  for (const q of queriesFor(m, target.titles)) {
    tried.push(q)
    for (const cand of await source.search(q)) {
      if (seen.has(cand.id)) continue
      seen.add(cand.id)
      if (cand.anilistId !== undefined) {
        // the source says which AniList entry it is: exact or nothing
        if (cand.anilistId === anilistId) {
          best = { cand, confidence: 1, offset: 0, reasons: ['source lists the same AniList ID'], specificity: 0 }
          break
        }
        continue
      }
      const c = candRef(cand)
      const options = [verifyDirect(target, c, m.status === 'FINISHED')]
      // only plausible candidates (title already close) are worth the AniList lookups of a relation walk
      const plausible = (options[0]?.confidence ?? titleSim(target, c).sim) >= 0.5
      if (plausible && target.episodes && (!c.episodes || c.episodes > target.episodes || c.year !== target.year)) {
        chains ??= {
          pre: await relationChain(m, deps, 'PREQUEL', 4),
          seq: await relationChain(m, deps, 'SEQUEL', 3),
        }
        options.push(verifyRun(target, chains.pre, chains.seq, c))
      }
      for (const o of options) {
        if (!o) continue
        const better =
          !best ||
          o.confidence > best.confidence + 1e-9 ||
          (Math.abs(o.confidence - best.confidence) < 1e-9 &&
            (o.specificity > best.specificity || (o.specificity === best.specificity && o.offset < best.offset)))
        if (better) best = { ...o, cand }
      }
    }
    if (best && best.confidence >= 0.95) break
  }

  if (!best) {
    const why = seen.size ? `${seen.size} candidates, all contradicted (year/format/season/part)` : 'no candidates'
    return none([`${why} for: ${tried.join(' | ')}`])
  }
  const confidence = Math.max(0, Math.min(1, best.confidence))
  if (confidence < threshold) {
    return none([`best "${best.cand.title}" scored ${confidence.toFixed(2)} < ${threshold}`, ...best.reasons])
  }
  return {
    sourceId: source.id,
    anilistId,
    showId: best.cand.id,
    title: best.cand.title,
    confidence: Number(confidence.toFixed(3)),
    episodeOffset: best.offset,
    ...(best.range ? { episodeRange: best.range } : {}),
    reasons: best.reasons,
  }
}
