ALTER TABLE "review_queue" ADD COLUMN "target_kind" text DEFAULT 'document' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ADD COLUMN "target_id" uuid;--> statement-breakpoint

-- KIND-DEPENDENT, not a blanket 'document'. memory-supersede / memory-contradict rows have
-- always held a memories.id in doc_id (41 + 20 of them in prod); labelling those 'document'
-- would make the id namespace wrong in a column that finally claims to be honest about it.
UPDATE "review_queue" SET
  "target_id"   = "doc_id",
  "target_kind" = CASE WHEN "kind" IN ('memory-supersede','memory-contradict')
                       THEN 'memory' ELSE 'document' END
WHERE "target_id" IS NULL;--> statement-breakpoint

ALTER TABLE "review_queue" ALTER COLUMN "target_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "review_queue" ALTER COLUMN "doc_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "review_queue_one_pending_per_doc";--> statement-breakpoint
CREATE UNIQUE INDEX "review_queue_one_pending_per_target"
  ON "review_queue" ("target_kind", "target_id") WHERE status = 'pending';
