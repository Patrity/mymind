CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "folders_path_uidx" ON "folders" USING btree ("path");
--> statement-breakpoint
-- Backfill: every ancestor folder of every live document path. Without this the registry
-- would only cover folders touched after deploy, and existing folders would still vanish
-- when emptied — the exact bug this table exists to fix.
INSERT INTO folders (path)
SELECT DISTINCT '/' || array_to_string(s.p[1:i], '/')
FROM (
  SELECT string_to_array(trim(both '/' from path), '/') AS p
  FROM documents
  WHERE deleted_at IS NULL
) s, generate_subscripts(s.p, 1) AS i
WHERE i < array_length(s.p, 1)
ON CONFLICT (path) DO NOTHING;