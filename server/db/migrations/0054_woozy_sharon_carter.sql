CREATE TABLE "agent_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"content" text NOT NULL,
	"attachments" jsonb,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"session_key" text NOT NULL,
	"trigger" text NOT NULL,
	"wake_reason" text,
	"profile" text NOT NULL,
	"model_def_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"input" jsonb NOT NULL,
	"origin_sink_id" text,
	"claimed_at" timestamp with time zone,
	"alive_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"usage" jsonb,
	"user_message_id" uuid,
	"assistant_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "review_queue_one_pending_per_target";--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "kind" text DEFAULT 'thread' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summarized_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_inbox" ADD CONSTRAINT "agent_inbox_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox" ADD CONSTRAINT "agent_inbox_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_inbox_run_idx" ON "agent_inbox" USING btree ("run_id","consumed_at");--> statement-breakpoint
CREATE INDEX "agent_runs_conv_status_idx" ON "agent_runs" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "agent_runs_status_created_idx" ON "agent_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_running" ON "agent_runs" USING btree ("conversation_id") WHERE status = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_main" ON "conversations" USING btree ("kind") WHERE kind = 'main';--> statement-breakpoint
CREATE UNIQUE INDEX "review_queue_one_pending_per_target" ON "review_queue" USING btree ("target_kind","target_id","kind") WHERE status = 'pending' and kind <> 'agent-action';