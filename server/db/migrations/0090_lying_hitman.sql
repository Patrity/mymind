ALTER TABLE "conversations" ADD COLUMN "branch_at_root" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_leaf_id" uuid;--> statement-breakpoint
-- Backfill: an existing summary was folded from the thread's ACTIVE path, so its last folded row is
-- the active-path row at or before summarized_through (ms-truncated: summarized_through was written
-- from a JS Date). UNION (not UNION ALL) is the cycle guard on a corrupt parent chain. A thread
-- with no such row keeps null (= trusted, the pre-cycle-88 behaviour). Nothing is deleted or nulled.
WITH RECURSIVE path AS (
  SELECT c.id AS conv, m.id, m.parent_id, m.created_at, c.summarized_through
    FROM conversations c JOIN conversation_messages m ON m.id = c.active_leaf_id
   WHERE c.summary IS NOT NULL AND c.summarized_through IS NOT NULL
  UNION
  SELECT p.conv, m.id, m.parent_id, m.created_at, p.summarized_through
    FROM path p JOIN conversation_messages m ON m.id = p.parent_id
)
UPDATE conversations c SET summary_leaf_id = (
  SELECT p.id FROM path p
   WHERE p.conv = c.id AND date_trunc('milliseconds', p.created_at) <= p.summarized_through
   ORDER BY p.created_at DESC, p.id DESC LIMIT 1
) WHERE c.summary IS NOT NULL AND c.summarized_through IS NOT NULL;
