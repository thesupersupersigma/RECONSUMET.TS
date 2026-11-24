CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"rate_limit" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "cache" (
	"ns" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cache_ns_key_pk" PRIMARY KEY("ns","key")
);
--> statement-breakpoint
CREATE TABLE "catalog" (
	"id" serial PRIMARY KEY NOT NULL,
	"anilist_id" integer,
	"mal_id" integer,
	"kitsu_id" integer,
	"anidb_id" integer,
	"title" text NOT NULL,
	"synonyms" text[] NOT NULL,
	"type" text NOT NULL,
	"episodes" integer NOT NULL,
	"status" text NOT NULL,
	"season" text,
	"year" integer,
	"picture" text,
	"duration" integer,
	"search" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"error" text,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "mappings" (
	"source_id" text NOT NULL,
	"anilist_id" integer NOT NULL,
	"show_id" text,
	"title" text,
	"confidence" real NOT NULL,
	"episode_offset" integer NOT NULL,
	"episode_range" integer[],
	"reasons" text[] NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mappings_source_id_anilist_id_pk" PRIMARY KEY("source_id","anilist_id")
);
--> statement-breakpoint
CREATE TABLE "overrides" (
	"source_id" text NOT NULL,
	"anilist_id" integer NOT NULL,
	"show_id" text,
	"episode_offset" integer,
	"episode_range" integer[],
	"note" text,
	"overridden_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "overrides_source_id_anilist_id_pk" PRIMARY KEY("source_id","anilist_id")
);
--> statement-breakpoint
CREATE TABLE "source_health" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"ok" boolean NOT NULL,
	"status" integer,
	"class" text NOT NULL,
	"ms" integer NOT NULL,
	"error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cache_expires_at" ON "cache" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_anilist_id" ON "catalog" USING btree ("anilist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_mal_id" ON "catalog" USING btree ("mal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_kitsu_id" ON "catalog" USING btree ("kitsu_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_anidb_id" ON "catalog" USING btree ("anidb_id");--> statement-breakpoint
CREATE INDEX "catalog_search_trgm" ON "catalog" USING gin ("search" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "job_runs_name_started" ON "job_runs" USING btree ("name","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "source_health_source_checked" ON "source_health" USING btree ("source_id","checked_at" DESC NULLS LAST);