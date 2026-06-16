ALTER TABLE "projects" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_pkey";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_uidx" ON "projects" ("slug");--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "git_remote_key" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repository_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "production_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "staging_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "aliases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "local_paths" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "last_activity_at" timestamptz;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_git_remote_key_uidx" ON "projects" ("git_remote_key") WHERE "git_remote_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_git_remote_key_idx" ON "projects" ("git_remote_key");--> statement-breakpoint
CREATE INDEX "projects_aliases_gin" ON "projects" USING gin ("aliases");--> statement-breakpoint
INSERT INTO "projects" ("slug","name") VALUES ('uncategorized','Uncategorized') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_id" uuid REFERENCES "projects"("id");--> statement-breakpoint
CREATE INDEX "sessions_project_id_idx" ON "sessions" ("project_id");--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "project_id" uuid REFERENCES "projects"("id");--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_date" timestamptz;--> statement-breakpoint
CREATE INDEX "memories_project_id_idx" ON "memories" ("project_id");
