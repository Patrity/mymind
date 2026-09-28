CREATE TABLE "channel_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"chat_guid" text NOT NULL,
	"prompt_guid" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"job_id" uuid,
	"run_id" uuid,
	"source" text DEFAULT 'reply' NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"first_claimed_at" timestamp with time zone,
	"last_error" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_inbound" (
	"guid" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"sender" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "reply_to" jsonb;--> statement-breakpoint
ALTER TABLE "channel_approvals" ADD CONSTRAINT "channel_approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_deliveries" ADD CONSTRAINT "channel_deliveries_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_deliveries" ADD CONSTRAINT "channel_deliveries_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_approvals_prompt_idx" ON "channel_approvals" USING btree ("prompt_guid");--> statement-breakpoint
CREATE INDEX "channel_deliveries_due_idx" ON "channel_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "channel_deliveries_message_idx" ON "channel_deliveries" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "channel_inbound_received_idx" ON "channel_inbound" USING btree ("channel","received_at");