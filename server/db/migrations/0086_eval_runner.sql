ALTER TABLE "eval_runs" ADD COLUMN "params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "owner" text;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "alive_at" timestamp with time zone;