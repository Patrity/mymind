ALTER TABLE "conversations" ADD COLUMN "active_leaf_id" uuid;
--> statement-breakpoint
-- Every pre-existing thread is already a valid linear path: appendMessages has always chained
-- each new message from the conversation's newest row, across turns. So pointing the leaf at
-- the newest message makes each thread a single-branch tree, and no code needs a
-- legacy-vs-branched split. The tail is identified STRUCTURALLY, not by timestamp/uuid: it is
-- the message that no other message names as parent. Timestamps collide (26% of messages share
-- one with a sibling) and `id` is a random uuid, so neither can reliably identify the tail.
UPDATE conversations c
SET active_leaf_id = (
  SELECT m.id FROM conversation_messages m
  WHERE m.conversation_id = c.id
    -- The tail is the message nothing else claims as its parent. Timestamps collide (26% of
    -- messages share one with a sibling) and `id` is a random uuid, so neither can identify it.
    AND NOT EXISTS (
      SELECT 1 FROM conversation_messages k WHERE k.parent_id = m.id
    )
  -- A well-formed linear chain has exactly ONE such row. This ordering only decides the case
  -- where a historical concurrent append produced two tails, so the result stays deterministic
  -- instead of erroring with "more than one row returned by a subquery".
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
)
WHERE c.active_leaf_id IS NULL
   -- Self-healing: also re-point any conversation whose recorded leaf HAS a child, which is
   -- exactly the rows the previous version of this backfill could have got wrong.
   OR EXISTS (
     SELECT 1 FROM conversation_messages k WHERE k.parent_id = c.active_leaf_id
   );