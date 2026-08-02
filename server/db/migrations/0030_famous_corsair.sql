-- Custom: content_hash must be maintained by the database, not by application code.
-- A bare generated expression is rejected ("generation expression is not immutable")
-- because convert_to() is not marked immutable; this wrapper is explicitly immutable,
-- which holds as long as the database encoding is UTF8.
CREATE OR REPLACE FUNCTION doc_content_hash(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "content_hash";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "content_hash" text
  GENERATED ALWAYS AS (doc_content_hash(content)) STORED;
