ALTER TABLE "workspaces" ADD COLUMN "inodes_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "tainted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "tainted_at" timestamp with time zone;