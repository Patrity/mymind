ALTER TABLE "workstreams" ADD COLUMN "is_child" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workstreams" ADD COLUMN "lifecycle_noted" text;--> statement-breakpoint
UPDATE "workstreams" SET "is_child" = true WHERE "parent_id" IS NOT NULL;