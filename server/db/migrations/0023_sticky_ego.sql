CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"ord" integer NOT NULL,
	"content" text NOT NULL,
	"context" text,
	"heading_path" text,
	"token_count" integer,
	"char_start" integer,
	"char_end" integer,
	"embedding" halfvec(2560),
	"embedded_text_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "chunked_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_source_ord_uidx" ON "chunks" USING btree ("source_type","source_id","ord");--> statement-breakpoint
CREATE INDEX "chunks_source_idx" ON "chunks" USING btree ("source_type","source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw ON chunks USING hnsw (embedding halfvec_cosine_ops);