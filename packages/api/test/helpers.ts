import type { AniListDetails, SkipTimes, Source, StreamResult } from '@reconsumet/core'
import { connectPglite, createApiKey, type Db, migrate, pgMappingStore } from '@reconsumet/db'
import { createApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

export const SECRET = 'test-secret-'.repeat(4)
export const UPSTREAM = 'cdn.upstream.example'

export const env = (extra: Record<string, string> = {}) =>
  loadConfig({
    DATABASE_URL: 'pglite://memory',
    PUBLIC_URL: 'https://api.example.org',
    RELAY_PUBLIC_URL: 'https://relay.example.org',
    RELAY_SECRET: SECRET,
    JOBS_ENABLED: 'false',
    ...extra,
  })

export const streams: StreamResult = {
  servers: [
    {
      name: 'HD-1',
      streams: [
        {
          url: `https://${UPSTREAM}/hd1/master.m3u8?token=eyIP`,
          type: 'hls',
          quality: 'auto',
          headers: { referer: 'https://flix.example/' },
          playlistKey: 'a2V5',
          ipLocked: true,
        },
      ],
      subtitles: [],
    },
    {
      name: 'HD-2',
      intro: { start: 10, end: 90 },
      streams: [
        {
          url: `https://${UPSTREAM}/hd2/master.m3u8`,
          type: 'hls',
          quality: 'auto',
          headers: { referer: 'https://flix.example/' },
          audioLang: 'jpn',
        },
      ],
      subtitles: [
        { lang: 'en', label: 'English', url: `https://${UPSTREAM}/subs/en.vtt`, format: 'vtt', default: true },
      ],
    },
  ],
}

export function fakeSource(id = 'fake'): Source & { calls: string[] } {
  const calls: string[] = []
  return {
    id,
    name: `Fake ${id}`,
    baseUrl: `https://${id}.example`,
    calls,
    search: async () => [],
    getShow: async (showId) => ({
      id: showId,
      title: 'Fake Show',
      episodes: Array.from({ length: 24 }, (_, i) => ({ number: i + 1, id: `${showId}/${i + 1}`, sub: true })),
    }),
    episodeId: (showId, n) => `${showId}/${n}`,
    getStreams: async (episodeId, opts) => {
      calls.push(`${episodeId}:${opts?.audio}`)
      return structuredClone(streams)
    },
    health: async () => ({ ok: true, status: 200, class: 'ok', ms: 12 }),
  }
}

export const media = {
  id: 1,
  idMal: null,
  title: { romaji: 'Fake Show 2nd Season', english: null, native: null },
  synonyms: [],
  format: 'TV',
  episodes: 12,
  status: 'FINISHED',
  season: 'FALL',
  seasonYear: 2024,
  startDate: { year: 2024, month: 10, day: 1 },
  endDate: { year: 2024, month: 12, day: 20 },
  duration: 24,
  coverImage: { extraLarge: null, large: null, medium: null, color: null },
  nextAiringEpisode: null,
  description: null,
  bannerImage: null,
  genres: [],
  tags: [],
  averageScore: null,
  meanScore: null,
  popularity: null,
  favourites: null,
  studios: [],
  source: null,
  countryOfOrigin: 'JP',
  isAdult: false,
  hashtag: null,
  siteUrl: null,
  trailer: null,
  characters: [],
  recommendations: [],
  externalLinks: [],
  // AniList numbering: the source has no titles, so episode 1 takes this one
  streamingEpisodes: [
    { title: 'Episode 1 - The Start', thumbnail: 'https://img.example/1.jpg', url: null, site: 'Crunchyroll' },
    { title: 'Episode 2', thumbnail: 'https://img.example/2.jpg', url: null, site: 'Crunchyroll' },
  ],
  relations: { edges: [] },
} satisfies AniListDetails

export const usage = {
  day: '2026-11-24',
  count: 3,
  cap: 3000,
  lastMinute: 1,
  perMinute: 20,
  sync: { count: 4, cap: 20 },
  pausedUntil: null,
}

export const skip: SkipTimes = { intro: { start: 1, end: 91 }, outro: { start: 1284, end: 1377 }, source: 'aniskip' }

export async function setup(extraEnv: Record<string, string> = {}, remote = '203.0.113.5') {
  const db: Db = await connectPglite()
  await migrate(db)
  // the fake show's season 2 = its episodes 13-24
  await pgMappingStore(db).setOverride('fake', 1, { showId: 'show', episodeOffset: 12, episodeRange: [13, 24] })
  const source = fakeSource()
  const config = env(extraEnv)
  const state = { remote }
  const skipCalls: [number, number, number][] = []
  const app = createApp({
    config,
    db,
    sources: new Map([[source.id, source]]),
    anilist: {
      media: async (id) => (id === 1 ? media : id === 2 ? { ...media, id: 2, idMal: 1535 } : null),
      usage: async () => usage,
    },
    aniskip: config.aniskipEnabled
      ? {
          skipTimes: async (...args) => {
            skipCalls.push(args)
            return skip
          },
        }
      : null,
    remoteAddr: () => state.remote,
  })
  const { key } = await createApiKey(db, 'site')
  return { app, db, source, key, state, config, skipCalls }
}
