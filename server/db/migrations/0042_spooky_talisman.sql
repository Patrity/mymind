ALTER TABLE "voice_presets" ADD COLUMN "ref_source" text;--> statement-breakpoint
-- Existing rows with a clip all came from the upload/record path; the lock flow did not
-- exist yet. Backfilled so `ref_source` is never null while a reference is present, which
-- is what the synthesis path keys on.
UPDATE "voice_presets" SET "ref_source" = 'upload' WHERE "ref_storage_key" IS NOT NULL AND "ref_source" IS NULL;
