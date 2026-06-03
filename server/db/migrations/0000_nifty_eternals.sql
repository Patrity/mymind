CREATE TABLE "projects" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"title" text,
	"content" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'plaintext' NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"project" text,
	"domain" text,
	"type" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"topic" text,
	"content_hash" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"public_slug" text,
	"embedding" halfvec(2560),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "documents_path_live_uidx" ON "documents" USING btree ("path") WHERE "documents"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_public_slug_uidx" ON "documents" USING btree ("public_slug");--> statement-breakpoint
CREATE INDEX "documents_tags_gin" ON "documents" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "documents_project_idx" ON "documents" USING btree ("project");

-- Custom: promote topic column to ltree and add specialized indexes
ALTER TABLE documents ALTER COLUMN topic TYPE ltree USING topic::ltree;
CREATE INDEX IF NOT EXISTS documents_topic_gist ON documents USING gist (topic);
CREATE INDEX IF NOT EXISTS documents_title_trgm ON documents USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS documents_content_trgm ON documents USING gin (content gin_trgm_ops);