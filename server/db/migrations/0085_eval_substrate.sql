CREATE TABLE "eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"prompt" text NOT NULL,
	"surface" text DEFAULT 'chat' NOT NULL,
	"setup" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expected_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_content" text[] DEFAULT '{}'::text[] NOT NULL,
	"match_mode" text DEFAULT 'ordered_subset' NOT NULL,
	"rubric" text,
	"n_runs" integer DEFAULT 3 NOT NULL,
	"max_steps" integer DEFAULT 40 NOT NULL,
	"holdout" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"score" real,
	"passed" boolean,
	"tool_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_text" text,
	"outcome" jsonb,
	"captured_writes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"duration_ms" integer,
	"tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"git_sha" text,
	"model_label" text,
	"prompt_hash" text,
	"tools_hash" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"summary" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eval_suites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_suite_id_eval_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_case_id_eval_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."eval_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_suite_id_eval_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_cases_suite_slug_idx" ON "eval_cases" USING btree ("suite_id","slug");--> statement-breakpoint
CREATE INDEX "eval_results_run_idx" ON "eval_results" USING btree ("run_id","case_id","attempt");--> statement-breakpoint
CREATE INDEX "eval_results_case_idx" ON "eval_results" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "eval_runs_suite_idx" ON "eval_runs" USING btree ("suite_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_suites_name_idx" ON "eval_suites" USING btree ("name");