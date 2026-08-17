CREATE TABLE "task_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"color" text DEFAULT 'neutral' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "task_columns_one_default_per_kind" ON "task_columns" USING btree ("kind") WHERE is_default;--> statement-breakpoint
CREATE INDEX "task_columns_position_idx" ON "task_columns" USING btree ("position");--> statement-breakpoint
-- Seed today's board, in today's order, with today's badge colours.
INSERT INTO "task_columns" (name, kind, color, position, is_default) VALUES
  ('Todo',        'open',    'neutral', 0, true),
  ('In Progress', 'started', 'primary', 1, true),
  ('Completed',   'done',    'success', 2, true),
  ('Blocked',     'blocked', 'error',   3, true);
--> statement-breakpoint
-- Add nullable, backfill, THEN enforce.
ALTER TABLE "tasks" ADD COLUMN "column_id" uuid;--> statement-breakpoint
UPDATE "tasks" t SET column_id = c.id FROM "task_columns" c
 WHERE (t.status = 'todo'        AND c.kind = 'open')
    OR (t.status = 'in_progress' AND c.kind = 'started')
    OR (t.status = 'completed'   AND c.kind = 'done')
    OR (t.status = 'blocked'     AND c.kind = 'blocked');
--> statement-breakpoint
-- Anything with an unexpected status lands in the default open column rather than blocking
-- the migration.
UPDATE "tasks" SET column_id = (SELECT id FROM "task_columns" WHERE kind='open' AND is_default)
 WHERE column_id IS NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "column_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_column_id_task_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."task_columns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_column_idx" ON "tasks" USING btree ("column_id");
-- NOTE: tasks.status and tasks_status_idx are deliberately LEFT IN PLACE. They are dropped in
-- Task 10, once every consumer reads columns. Dropping here would leave the branch red for six
-- tasks and throw away the rollback path during the riskiest part of the cycle.
