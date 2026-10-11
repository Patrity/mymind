CREATE TABLE "workstreams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"origin_conversation_id" uuid,
	"goal" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"toolsets" text[] DEFAULT '{}'::text[] NOT NULL,
	"budget" jsonb NOT NULL,
	"used" jsonb NOT NULL,
	"attention" jsonb,
	"summary" text,
	"failure_reason" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_outcome" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"current_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "kind" text DEFAULT 'turn' NOT NULL;--> statement-breakpoint
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_origin_conversation_id_conversations_id_fk" FOREIGN KEY ("origin_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workstreams_conversation_idx" ON "workstreams" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "workstreams_state_idx" ON "workstreams" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_active_segment" ON "agent_runs" USING btree ("conversation_id") WHERE kind = 'workstream' and status in ('queued', 'running');