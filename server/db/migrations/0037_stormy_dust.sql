CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_path_format_check" CHECK ("folders"."path" ~ '^/' AND "folders"."path" !~ '/$' AND "folders"."path" !~ '//')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "folders_path_uidx" ON "folders" USING btree ("path");
--> statement-breakpoint
-- Backfill: every ancestor folder of every live document path. Without this the registry
-- would only cover folders touched after deploy, and existing folders would still vanish
-- when emptied — the exact bug this table exists to fix. Repeated slashes are collapsed
-- before splitting (regexp_replace ... '/+' -> '/'): `trim(both '/' from path)` only strips
-- the ends, so `/projects//mymind/foo.md` would otherwise yield a `/projects/` (trailing
-- slash) and a `/projects//mymind` (embedded double slash) row, both violating
-- folders_path_format_check. buildTree (server/services/tree.ts) already treats an empty
-- path segment as absent via `.filter(Boolean)`, so normalizing here makes the registry
-- agree with the tree the user already sees instead of rejecting/skipping those documents.
INSERT INTO folders (path)
SELECT DISTINCT '/' || array_to_string(s.p[1:i], '/')
FROM (
  SELECT string_to_array(regexp_replace(trim(both '/' from path), '/+', '/', 'g'), '/') AS p
  FROM documents
  WHERE deleted_at IS NULL
) s, generate_subscripts(s.p, 1) AS i
WHERE i < array_length(s.p, 1)
ON CONFLICT (path) DO NOTHING;