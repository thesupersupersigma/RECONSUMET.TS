// The API contract: request + response shapes. @reconsumet/client re-exports these for the site.
import { z } from '@hono/zod-openapi'

export const ErrorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi('Error', { example: { error: { code: 'not_found', message: 'no such anime' } } })

export const AnilistIdParam = z.object({
  anilistId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'anilistId', in: 'path' }, example: 154587 }),
})

const Title = z.object({ romaji: z.string().nullable(), english: z.string().nullable(), native: z.string().nullable() })

export const CatalogEntrySchema = z
  .object({
    anilistId: z.number().int().optional(),
    malId: z.number().int().optional(),
    kitsuId: z.number().int().optional(),
    anidbId: z.number().int().optional(),
    title: z.string(),
    synonyms: z.array(z.string()),
    type: z.string().openapi({ description: 'TV | MOVIE | OVA | ONA | SPECIAL | UNKNOWN' }),
    episodes: z.number().int().openapi({ description: '0 = unknown' }),
    status: z.string().openapi({ description: 'FINISHED | ONGOING | UPCOMING | UNKNOWN' }),
    season: z.string().nullable(),
    year: z.number().int().nullable(),
    picture: z.string().nullable(),
    duration: z.number().nullable().openapi({ description: 'seconds per episode' }),
    isAdult: z.boolean().optional().openapi({ description: 'adult (hentai) title; absent = unknown' }),
  })
  .openapi('CatalogEntry')

const FuzzyDate = z.object({
  year: z.number().int().nullable(),
  month: z.number().int().nullable(),
  day: z.number().int().nullable(),
})
const Cover = z.object({ large: z.string().nullable() }).nullable()
const Person = z.object({
  id: z.number().int(),
  name: z.string().nullable(),
  nameNative: z.string().nullable(),
  image: z.string().nullable(),
})

export const AnimeSchema = z
  .object({
    id: z.number().int(),
    idMal: z.number().int().nullable(),
    title: Title,
    synonyms: z.array(z.string()),
    format: z.string().nullable(),
    episodes: z.number().int().nullable(),
    status: z.string().nullable(),
    season: z.string().nullable(),
    seasonYear: z.number().int().nullable(),
    duration: z.number().nullable().openapi({ description: 'minutes per episode (AniList)' }),
    startDate: FuzzyDate,
    endDate: FuzzyDate,
    coverImage: z.object({
      extraLarge: z.string().nullable(),
      large: z.string().nullable(),
      medium: z.string().nullable(),
      color: z.string().nullable().openapi({ description: '#rrggbb' }),
    }),
    bannerImage: z.string().nullable(),
    description: z.string().nullable().openapi({ description: "AniList's HTML as given: sanitize before rendering" }),
    genres: z.array(z.string()),
    tags: z.array(
      z.object({ name: z.string(), rank: z.number().nullable(), isSpoiler: z.boolean(), isAdult: z.boolean() }),
    ),
    averageScore: z.number().int().nullable(),
    meanScore: z.number().int().nullable(),
    popularity: z.number().int().nullable(),
    favourites: z.number().int().nullable(),
    studios: z
      .array(z.object({ id: z.number().int(), name: z.string(), isAnimationStudio: z.boolean(), isMain: z.boolean() }))
      .openapi({ description: 'main studios first' }),
    source: z.string().nullable(),
    countryOfOrigin: z.string().nullable(),
    isAdult: z.boolean(),
    hashtag: z.string().nullable(),
    siteUrl: z.string().nullable(),
    trailer: z
      .object({ site: z.string().nullable(), id: z.string().nullable(), thumbnail: z.string().nullable() })
      .nullable()
      .openapi({ description: 'site: youtube | dailymotion' }),
    characters: z
      .array(
        Person.extend({
          role: z.string().openapi({ description: 'MAIN | SUPPORTING | BACKGROUND' }),
          voiceActor: Person.nullable().openapi({ description: 'Japanese' }),
          voiceActorEnglish: Person.nullable(),
        }),
      )
      .openapi({ description: 'first 12, MAIN first' }),
    recommendations: z
      .array(
        z.object({
          id: z.number().int(),
          title: Title,
          format: z.string().nullable(),
          episodes: z.number().int().nullable(),
          averageScore: z.number().int().nullable(),
          coverImage: Cover,
        }),
      )
      .openapi({ description: 'first 12 by rating' }),
    externalLinks: z.array(
      z.object({
        site: z.string(),
        url: z.string().nullable(),
        type: z.string().nullable().openapi({ description: 'INFO | STREAMING | SOCIAL' }),
        language: z.string().nullable(),
      }),
    ),
    streamingEpisodes: z.array(
      z.object({
        title: z.string().nullable(),
        thumbnail: z.string().nullable(),
        url: z.string().nullable(),
        site: z.string().nullable(),
      }),
    ),
    nextAiringEpisode: z.object({ episode: z.number().int(), airingAt: z.number().int() }).nullable(),
    relations: z.object({
      edges: z.array(
        z.object({
          relationType: z.string(),
          node: z.object({
            id: z.number().int(),
            type: z.string(),
            format: z.string().nullable(),
            episodes: z.number().int().nullable(),
            status: z.string().nullable(),
            seasonYear: z.number().int().nullable(),
            title: Title,
            coverImage: Cover,
            averageScore: z.number().int().nullable(),
          }),
        }),
      ),
    }),
  })
  .openapi('Anime')

export const HealthSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  class: z.string(),
  ms: z.number(),
  error: z.string().optional(),
  checkedAt: z.string().openapi({ format: 'date-time' }),
})

export const SourceSchema = z
  .object({ id: z.string(), name: z.string(), baseUrl: z.string(), health: HealthSchema.nullable() })
  .openapi('Source')

export const AudioSchema = z.enum(['sub', 'dub'])

export const EpisodesSchema = z
  .object({
    source: z.string(),
    showId: z.string(),
    confidence: z.number(),
    episodes: z.array(
      z.object({
        number: z.number().openapi({ description: 'AniList numbering (the source offset is already applied)' }),
        title: z.string().optional().openapi({ description: "the source's, else AniList's streamingEpisodes" }),
        thumbnail: z.string().optional().openapi({ description: "from AniList's streamingEpisodes" }),
        sub: z.boolean().optional(),
        dub: z.boolean().optional(),
      }),
    ),
  })
  .openapi('Episodes')

export const StreamsSchema = z
  .object({
    source: z.string(),
    anilistId: z.number().int(),
    episode: z.number(),
    sourceEpisode: z.number(),
    audio: AudioSchema,
    expiresAt: z.string().openapi({ format: 'date-time', description: 'top-level relay URLs stop working after this' }),
    servers: z.array(
      z.object({
        name: z.string(),
        intro: z.object({ start: z.number(), end: z.number() }).optional(),
        outro: z.object({ start: z.number(), end: z.number() }).optional(),
        streams: z.array(
          z.object({
            url: z.string().openapi({ description: 'relay URL with a sealed token, never an upstream URL' }),
            type: z.enum(['hls', 'mp4']),
            quality: z.string(),
            audioLang: z.string().optional(),
          }),
        ),
        subtitles: z.array(
          z.object({
            lang: z.string(),
            label: z.string(),
            url: z.string(),
            format: z.enum(['vtt', 'ass', 'srt']),
            default: z.boolean(),
          }),
        ),
      }),
    ),
  })
  .openapi('Streams')

const Interval = z.object({ start: z.number(), end: z.number() })
export const SkipSchema = z
  .object({ intro: Interval.optional(), outro: Interval.optional(), source: z.enum(['aniskip', 'none']) })
  .openapi('SkipTimes', {
    example: { intro: { start: 1.04, end: 91.04 }, outro: { start: 1284, end: 1377 }, source: 'aniskip' },
  })

export const StatusSchema = z
  .object({
    version: z.string(),
    anilist: z.object({
      day: z.string().openapi({ description: 'UTC day the counters are for' }),
      count: z.number().int().openapi({ description: 'on-demand requests today' }),
      cap: z.number().int(),
      lastMinute: z.number().int().openapi({ description: 'on-demand requests in the last minute (this process)' }),
      perMinute: z.number().int(),
      sync: z.object({ count: z.number().int(), cap: z.number().int() }),
      pausedUntil: z.string().nullable().openapi({ description: 'AniList asked us to back off until then' }),
    }),
    aniskip: z.boolean(),
  })
  .openapi('Status')

export type CatalogEntryT = z.infer<typeof CatalogEntrySchema>
export type AnimeT = z.infer<typeof AnimeSchema>
export type SourceT = z.infer<typeof SourceSchema>
export type EpisodesT = z.infer<typeof EpisodesSchema>
export type StreamsT = z.infer<typeof StreamsSchema>
export type SkipT = z.infer<typeof SkipSchema>
export type StatusT = z.infer<typeof StatusSchema>
export type ApiError = z.infer<typeof ErrorSchema>
