CREATE TABLE "sess_summary_state" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"last_summarized_message_count" integer DEFAULT 0 NOT NULL,
	"last_run" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"error" text,
	"duration_ms" integer,
	"model" text,
	"summary_chars" integer,
	"title_chars" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "summary_embedding" halfvec(2560);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_embedded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "embedding" halfvec(2560);--> statement-breakpoint
CREATE INDEX "sess_summary_state_last_run_idx" ON "sess_summary_state" USING btree ("last_run");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_embedding_hnsw ON messages USING hnsw (embedding halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_summary_embedding_hnsw ON sessions USING hnsw (summary_embedding halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_content_trgm ON messages USING gin (content gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_title_trgm ON sessions USING gin (title gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_summary_trgm ON sessions USING gin (summary gin_trgm_ops);