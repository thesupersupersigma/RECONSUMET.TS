import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const at = (name: string) => timestamp(name, { withTimezone: true })

export const catalog = pgTable(
  'catalog',
  {
    id: serial('id').primaryKey(),
    anilistId: integer('anilist_id'),
    malId: integer('mal_id'),
    kitsuId: integer('kitsu_id'),
    anidbId: integer('anidb_id'),
    title: text('title').notNull(),
    synonyms: text('synonyms').array().notNull(),
    type: text('type').notNull(),
    episodes: integer('episodes').notNull(),
    status: text('status').notNull(),
    season: text('season'),
    year: integer('year'),
    picture: text('picture'),
    duration: integer('duration'),
    isAdult: boolean('is_adult'),
    /** normalizeTitle(title + synonyms) joined with ' | ', for trigram search. */
    search: text('search').notNull(),
  },
  (t) => [
    uniqueIndex('catalog_anilist_id').on(t.anilistId),
    uniqueIndex('catalog_mal_id').on(t.malId),
    uniqueIndex('catalog_kitsu_id').on(t.kitsuId),
    uniqueIndex('catalog_anidb_id').on(t.anidbId),
    index('catalog_search_trgm').using('gin', sql`${t.search} gin_trgm_ops`),
  ],
)

export const catalogMeta = pgTable('catalog_meta', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
})

export const mappings = pgTable(
  'mappings',
  {
    sourceId: text('source_id').notNull(),
    anilistId: integer('anilist_id').notNull(),
    showId: text('show_id'),
    title: text('title'),
    confidence: real('confidence').notNull(),
    episodeOffset: integer('episode_offset').notNull(),
    episodeRange: integer('episode_range').array(),
    reasons: text('reasons').array().notNull(),
    checkedAt: at('checked_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.anilistId] })],
)

export const overrides = pgTable(
  'overrides',
  {
    sourceId: text('source_id').notNull(),
    anilistId: integer('anilist_id').notNull(),
    showId: text('show_id'),
    episodeOffset: integer('episode_offset'),
    episodeRange: integer('episode_range').array(),
    note: text('note'),
    overriddenAt: at('overridden_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.anilistId] })],
)

export const cache = pgTable(
  'cache',
  {
    ns: text('ns').notNull(),
    key: text('key').notNull(),
    value: jsonb('value'),
    fetchedAt: at('fetched_at').notNull().defaultNow(),
    expiresAt: at('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ns, t.key] }), index('cache_expires_at').on(t.expiresAt)],
)

export const apiKeys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  /** Requests per minute; null = the default key tier. */
  rateLimit: integer('rate_limit'),
  createdAt: at('created_at').notNull().defaultNow(),
  lastUsedAt: at('last_used_at'),
  revokedAt: at('revoked_at'),
})

export const sourceHealth = pgTable(
  'source_health',
  {
    id: serial('id').primaryKey(),
    sourceId: text('source_id').notNull(),
    ok: boolean('ok').notNull(),
    status: integer('status'),
    class: text('class').notNull(),
    ms: integer('ms').notNull(),
    error: text('error'),
    checkedAt: at('checked_at').notNull().defaultNow(),
  },
  (t) => [index('source_health_source_checked').on(t.sourceId, t.checkedAt.desc())],
)

export const jobRuns = pgTable(
  'job_runs',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    startedAt: at('started_at').notNull(),
    finishedAt: at('finished_at'),
    ok: boolean('ok'),
    error: text('error'),
    result: jsonb('result'),
  },
  (t) => [index('job_runs_name_started').on(t.name, t.startedAt.desc())],
)
