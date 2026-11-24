import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AniListMedia } from '../src/anilist/client.ts'
import { createMatcher, queriesFor, stripStructure } from '../src/match/index.ts'
import { normalizeTitle, parseTitle, similarity } from '../src/match/title.ts'
import type { Source } from '../src/sources/types.ts'
import { fixture, tempDir } from './helpers.ts'

describe('titles', () => {
  it('normalizes case, accents, punctuation and apostrophes', () => {
    expect(normalizeTitle('Frieren: Beyond Journey’s End')).toBe(normalizeTitle('frieren beyond journeys end'))
    expect(normalizeTitle('Pokémon')).toBe('pokemon')
  })

  it('treats season / part / cour / year markers as structure', () => {
    expect(parseTitle('Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2')).toMatchObject({
      base: 're zero kara hajimeru isekai seikatsu',
      season: 2,
      part: 2,
    })
    expect(parseTitle('Spy x Family (2022)')).toMatchObject({ base: 'spy x family', year: 2022 })
    expect(parseTitle('Shingeki no Kyojin Season 3')).toMatchObject({ season: 3 })
    expect(parseTitle('Mushoku Tensei S2')).toMatchObject({ season: 2 })
    expect(parseTitle('Kaguya-sama: Cour 2').part).toBe(2)
    expect(parseTitle('Shingeki no Kyojin: The Final Season').base).toBe('shingeki no kyojin final')
  })

  it('similarity: identical 1, word-subset 0.8, unrelated low', () => {
    expect(similarity('one piece', 'one piece')).toBe(1)
    expect(similarity('gintama', 'gintama porori hen')).toBe(0.8)
    expect(similarity('naruto', 'bleach')).toBeLessThan(0.2)
  })

  it('broad queries strip the structure', () => {
    expect(stripStructure('Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2')).toBe(
      'Re:Zero kara Hajimeru Isekai Seikatsu',
    )
    expect(stripStructure('Shingeki no Kyojin OVA')).toBe('Shingeki no Kyojin')
    expect(stripStructure('Spy x Family (2022)')).toBe('Spy x Family')
    const m = { title: { romaji: 'Gintama.: Porori-hen', english: 'Gintama.: Slip Arc', native: null } } as AniListMedia
    expect(queriesFor(m, ['Gintama. (2017)'])).toEqual(['Gintama.: Porori-hen', 'Gintama.', 'Gintama. (2017)', 'Gintama.: Slip Arc'])
  })
})

describe('createMatcher', () => {
  const media = async () => JSON.parse(await fixture('anilist/__fixtures__/media-119661.json')).data.Media

  it('caches mappings and lets overrides.json win', async () => {
    const dir = await tempDir()
    let searches = 0
    const source = {
      id: 'fake',
      search: async () => {
        searches++
        return [{ id: 'abc', title: 'Re:Zero kara Hajimeru Isekai Seikatsu (2021)', altTitles: [], type: 'TV', year: 2021, episodes: 12 }]
      },
      episodeId: (s: string, n: number) => `${s}/${n}`,
    } as unknown as Source
    const m = await media()
    const matcher = createMatcher({ media: async () => m, catalog: { get: async () => undefined }, dir })

    const first = await matcher.match(119661, source)
    expect(first).toMatchObject({ showId: 'abc', episodeOffset: 0 })
    await matcher.match(119661, source)
    expect(searches).toBeGreaterThan(0)
    const before = searches
    await matcher.match(119661, source) // cached
    expect(searches).toBe(before)
    expect((await matcher.resolveEpisode(119661, 3, source)).episodeId).toBe('abc/3')

    await writeFile(join(dir, 'overrides.json'), JSON.stringify({ 'fake:119661': { showId: 'xyz', episodeOffset: 13, note: 'test' } }))
    const o = await matcher.match(119661, source)
    expect(o).toMatchObject({ showId: 'xyz', episodeOffset: 13, reasons: ['manual override: test'] })
    expect((await matcher.resolveEpisode(119661, 1, source)).episodeId).toBe('xyz/14')

    await writeFile(join(dir, 'overrides.json'), JSON.stringify({ 'fake:119661': { showId: null } }))
    await expect(matcher.resolveEpisode(119661, 1, source)).rejects.toThrow(/no match/)
  })

  it('says "no match" instead of guessing below the threshold', async () => {
    const source = {
      id: 'fake',
      search: async () => [{ id: 'x', title: 'Totally Different Show', altTitles: [], type: 'TV', year: 2021, episodes: 12 }],
    }
    const m = await media()
    const matcher = createMatcher({ media: async () => m, catalog: { get: async () => undefined }, dir: await tempDir() })
    const r = await matcher.match(119661, source)
    expect(r.showId).toBeNull()
    expect(r.reasons[0]).toMatch(/scored .* < 0\.65/)
  })
})
