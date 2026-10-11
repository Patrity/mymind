CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"workstream_id" uuid,
	"container_id" text,
	"state" text DEFAULT 'stopped' NOT NULL,
	"bytes_used" bigint DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_workstream_id_workstreams_id_fk" FOREIGN KEY ("workstream_id") REFERENCES "public"."workstreams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_workstream_idx" ON "workspaces" USING btree ("workstream_id") WHERE "workspaces"."workstream_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_home_idx" ON "workspaces" USING btree ("kind") WHERE "workspaces"."kind" = 'home' and "workspaces"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "workspaces_state_idx" ON "workspaces" USING btree ("state","last_used_at");