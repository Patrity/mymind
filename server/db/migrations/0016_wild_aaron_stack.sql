CREATE TABLE "tool_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" uuid,
	"tool_name" text NOT NULL,
	"args" jsonb,
	"result" jsonb,
	"exit_status" text,
	"phase" text DEFAULT 'completed' NOT NULL,
	"tool_use_id" text,
	"is_sidechain" boolean DEFAULT false NOT NULL,
	"caller_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "machine_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "hostname" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "git_branch" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "git_commit" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "git_remote" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "app_version" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "parent_uuid" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "thinking" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "is_sidechain" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "usage" jsonb;--> statement-breakpoint
CREATE INDEX "tool_events_session_idx" ON "tool_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "tool_events_tool_name_idx" ON "tool_events" USING btree ("tool_name");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_events_session_tooluse_uidx" ON "tool_events" USING btree ("session_id","tool_use_id");--> statement-breakpoint
CREATE INDEX "sessions_machine_idx" ON "sessions" USING btree ("machine_id");