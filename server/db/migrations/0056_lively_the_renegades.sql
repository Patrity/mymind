CREATE TABLE "agent_config_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"content" text NOT NULL,
	"actor" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_job_fires" (
	"job_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_job_fires_pkey" PRIMARY KEY("job_id","event_key")
);
--> statement-breakpoint
CREATE TABLE "agent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"source" text DEFAULT 'human' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"trigger_kind" text,
	"trigger_expr" text,
	"timezone" text,
	"next_run_at" timestamp with time zone,
	"parse_error" text,
	"last_run_at" timestamp with time zone,
	"last_run_id" uuid,
	"last_outcome" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"name" text,
	"description" text,
	"when_to_use" text,
	"active" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'human' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_job_fires" ADD CONSTRAINT "agent_job_fires_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_config_revisions_target" ON "agent_config_revisions" USING btree ("target_kind","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_jobs_slug" ON "agent_jobs" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "agent_jobs_due" ON "agent_jobs" USING btree ("next_run_at") WHERE enabled and parse_error is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skills_slug" ON "agent_skills" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE set null ON UPDATE no action;