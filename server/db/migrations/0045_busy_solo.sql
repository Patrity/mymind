ALTER TABLE "conversations" ADD COLUMN "active_leaf_id" uuid;
--> statement-breakpoint
-- Every pre-existing thread is already a valid linear path: appendMessages has always chained
-- each new message from the conversation's newest row, across turns. So pointing the leaf at
-- the newest message makes each thread a single-branch tree, and no code needs a
-- legacy-vs-branched split.
UPDATE conversations c
SET active_leaf_id = (
  SELECT m.id FROM conversation_messages m
  WHERE m.conversation_id = c.id
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
)
WHERE active_leaf_id IS NULL;