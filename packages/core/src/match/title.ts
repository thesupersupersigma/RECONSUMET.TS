// Title normalization + structure parsing. "Season 2", "2nd Season", "S2", "Part 2", "Cour 2" and a trailing
// "(2023)" are structure, not text: they're pulled out into numbers and removed before comparing titles.

export interface TitleInfo {
  /** Lowercase, accent-free, punctuation-free, structure markers removed. */
  base: string
  season?: number
  part?: number
  /** A year in parentheses at the end, e.g. AniDB-style "Spy x Family (2022)". */
  year?: number
}

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, final: 0 }

export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents
    .toLowerCase()
    .replace(/[`'’‘]/g, '') // "Journey's" == "Journeys" == "Journey`s"
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function parseTitle(raw: string): TitleInfo {
  let s = normalizeTitle(raw)
  const info: TitleInfo = { base: '' }
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = s.match(re)
    if (!m) return
    fn(m)
    s = s.replace(re, ' ')
  }
  const yearM = raw.match(/\((\d{4})\)\s*$/)
  if (yearM) info.year = Number(yearM[1])
  s = s.replace(/\b(19|20)\d{2}\s*$/, ' ')
  take(/\b(?:part|cour)\s*(\d{1,2})\b/, (m) => (info.part = Number(m[1])))
  take(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:part|cour)\b/, (m) => (info.part = Number(m[1])))
  take(/\bseason\s*(\d{1,2})\b/, (m) => (info.season = Number(m[1])))
  take(/\b(\d{1,2})(?:st|nd|rd|th)\s*season\b/, (m) => (info.season = Number(m[1])))
  take(/\b(first|second|third|fourth|fifth|sixth)\s+season\b/, (m) => (info.season = ORDINALS[m[1] as string]))
  take(/\bs(\d{1,2})\b/, (m) => (info.season = Number(m[1])))
  s = s.replace(/\b(?:the|tv|season)\b/g, ' ') // leftovers: "The Final Season" keeps "final"
  info.base = s.replace(/\s+/g, ' ').trim()
  return info
}

/** Sørensen–Dice similarity on character bigrams of the normalized bases (0..1). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2)
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }
  let hits = 0
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2)
    const n = grams.get(g) ?? 0
    if (n > 0) {
      grams.set(g, n - 1)
      hits++
    }
  }
  return (2 * hits) / (a.length + b.length - 2)
}
