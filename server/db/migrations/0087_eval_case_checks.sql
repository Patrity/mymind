ALTER TABLE "eval_cases" ADD COLUMN "expect_flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "expect_tainted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "expected_approvals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "forbidden_approvals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "count_failed" boolean DEFAULT false NOT NULL;