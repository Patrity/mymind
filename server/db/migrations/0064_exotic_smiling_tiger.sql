ALTER TABLE "memories" ADD COLUMN "jev_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "audit_keep" real;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "audit_verdict" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "audit_reason" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "audit_model" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "audit_prompt_version" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "audited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "audit_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "extract_prompt_version" text;