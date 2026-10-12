CREATE TABLE "approval_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce" text NOT NULL,
	"run_id" uuid,
	"workstream_id" uuid,
	"tool" text NOT NULL,
	"rule_floor" text NOT NULL,
	"rule_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk" text,
	"recommendation" text,
	"confidence" real,
	"reasons" jsonb,
	"model" text,
	"latency_ms" integer,
	"error" text,
	"verdict_at" timestamp with time zone,
	"decision" text,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_verdicts_nonce_idx" ON "approval_verdicts" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "approval_verdicts_run_idx" ON "approval_verdicts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "approval_verdicts_created_idx" ON "approval_verdicts" USING btree ("created_at");