ALTER TABLE "memories" ADD COLUMN "jev_score" real;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "jev_answers" jsonb;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "jev_scored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "jev_model" text;