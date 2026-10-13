ALTER TABLE "workstreams" ADD COLUMN "verification" jsonb;--> statement-breakpoint
ALTER TABLE "workstreams" ADD COLUMN "send_backs" integer DEFAULT 0 NOT NULL;