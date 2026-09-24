ALTER TABLE "memories" ADD COLUMN "resident" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "retrieval_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "last_retrieved_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "memories_resident_idx" ON "memories" USING btree ("resident") WHERE "memories"."resident";--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_resident_implies_global" CHECK (not "memories"."resident" or "memories"."applicability" = 'global');