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
  })
  .openapi('CatalogEntry')

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
    coverImage: z.object({ large: z.string().nullable() }).nullable().optional(),
    nextAiringEpisode: z.object({ episode: z.number().int(), airingAt: z.number().int() }).nullable(),
    relations: z
      .object({
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
            }),
          }),
        ),
      })
      .optional(),
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
        title: z.string().optional(),
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

export type CatalogEntryT = z.infer<typeof CatalogEntrySchema>
export type AnimeT = z.infer<typeof AnimeSchema>
export type SourceT = z.infer<typeof SourceSchema>
export type EpisodesT = z.infer<typeof EpisodesSchema>
export type StreamsT = z.infer<typeof StreamsSchema>
export type ApiError = z.infer<typeof ErrorSchema>
