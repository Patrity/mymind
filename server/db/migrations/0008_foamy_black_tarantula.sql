CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text DEFAULT 'user' NOT NULL,
	"content" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" text,
	"embedding" halfvec(2560),
	"content_hash" text NOT NULL,
	"confidence" real,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"project" text,
	"session_id" uuid,
	"enriched_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"project" text,
	"cwd" text,
	"title" text,
	"summary" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text,
	"content" text DEFAULT '' NOT NULL,
	"external_uuid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mem_enrichment_state" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"last_enriched_message_count" integer DEFAULT 0 NOT NULL,
	"last_run" timestamp with time zone,
	"status" text,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "memories_scope_idx" ON "memories" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "memories_tags_gin" ON "memories" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_content_hash_live_uidx" ON "memories" USING btree ("content_hash") WHERE "memories"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_source_external_uidx" ON "sessions" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "messages_session_idx" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_session_extuuid_uidx" ON "messages" USING btree ("session_id","external_uuid");
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw ON memories USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX IF NOT EXISTS memories_content_trgm ON memories USING gin (content gin_trgm_ops);