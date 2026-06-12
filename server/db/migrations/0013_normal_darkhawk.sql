ALTER TABLE "documents" ADD COLUMN "ocr_id" uuid;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "embedding" halfvec(2560);--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "enrich_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "enrich_error" text;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "make_document" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "images" RENAME COLUMN "ocr_attempts" TO "enrich_attempts";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS images_embedding_hnsw ON images USING hnsw (embedding halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS images_ocr_text_trgm ON images USING gin (ocr_text gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS images_summary_trgm ON images USING gin (summary gin_trgm_ops);
