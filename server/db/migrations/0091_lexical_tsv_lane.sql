-- 0091: stored tsvector + GIN per lexical-search surface (2026-10-19 stack review, R3 §6 step 4).
-- Replaces the ILIKE/pg_trgm lexical lane with websearch_to_tsquery + ts_rank_cd; see
-- packages/core/src/lib/search/lexical.ts. ADD COLUMN ... GENERATED STORED REWRITES each table under
-- ACCESS EXCLUSIVE (messages ≈265k rows / the bulk of the 2.4 GB DB: expect minutes, run at a quiet
-- time). drizzle-kit applies every migration inside ONE transaction, so CREATE INDEX CONCURRENTLY is
-- not possible here; the indexes are IF NOT EXISTS so an operator may pre-build them concurrently by
-- hand after the columns exist and this file then skips them. `left(…, 200000)` on the two big-text
-- tables keeps every row under the 1 MB tsvector hard limit.
ALTER TABLE "documents" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', left(coalesce(title, '') || ' ' || content, 200000))) STORED;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))) STORED;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', left(content, 200000))) STORED;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading_path, '') || ' ' || coalesce(context, '') || ' ' || content)) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_tsv_gin" ON "documents" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_tsv_gin" ON "memories" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_tsv_gin" ON "sessions" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_tsv_gin" ON "messages" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_tsv_gin" ON "chunks" USING gin ("tsv");