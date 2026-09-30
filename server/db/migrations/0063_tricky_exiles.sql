CREATE TABLE "agent_improvements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pass" text NOT NULL,
	"source_conversation_id" uuid,
	"source_run_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"jev" jsonb,
	"route" text NOT NULL,
	"drop_reason" text,
	"status" text NOT NULL,
	"revision_id" uuid,
	"review_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"updated_by" text DEFAULT 'human' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"run_id" uuid,
	"message_id" uuid,
	"delivery_id" uuid,
	"kind" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "reflected_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_config_revisions" ADD COLUMN "improvement_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_signals" ADD CONSTRAINT "agent_signals_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_signals" ADD CONSTRAINT "agent_signals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_improvements_status_created_idx" ON "agent_improvements" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "agent_improvements_kind_target_created_idx" ON "agent_improvements" USING btree ("kind","target","created_at");--> statement-breakpoint
CREATE INDEX "agent_signals_job_created_idx" ON "agent_signals" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_signals_message_kind" ON "agent_signals" USING btree ("message_id","kind") WHERE "agent_signals"."message_id" is not null;