ALTER TABLE "mem_enrichment_state" RENAME COLUMN "session_id" TO "source_id";--> statement-breakpoint
ALTER TABLE "mem_enrichment_state" ADD COLUMN "source_kind" text DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE "mem_enrichment_state" DROP CONSTRAINT "mem_enrichment_state_pkey";--> statement-breakpoint
ALTER TABLE "mem_enrichment_state" ADD PRIMARY KEY ("source_kind", "source_id");
