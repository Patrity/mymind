-- Repair the rows the split ownership of `ref_source` produced, BEFORE the constraints
-- below can reject them.
--
-- A clip with no source: the clip is real, only its provenance was never recorded. A lock
-- render is identifiable from its transcript — lock.post.ts stores LOCK_PASSAGE verbatim as
-- `ref_text` — and anything else came from the upload/record path. Guessing 'upload' for a
-- lock render would be the damaging direction: it re-applies the instruction over a
-- reference that already contains it, which measured WORSE than not locking at all
-- (39.8 Hz against 23.9).
UPDATE "voice_presets"
SET "ref_source" = CASE
  WHEN "ref_text" LIKE 'This is the voice I will use from now on.%' THEN 'locked'
  ELSE 'upload'
END
WHERE "ref_storage_key" IS NOT NULL AND "ref_source" IS NULL;--> statement-breakpoint

-- A source with no clip: the clip was cleared and the label left behind. Nothing to point
-- at, so the label goes. The cap and its marker go with it — they were measured against the
-- clip that is gone, and unlock.post.ts resets them for the same reason.
UPDATE "voice_presets"
SET "ref_source" = NULL, "ref_text" = NULL, "ref_duration_ms" = NULL,
    "max_segment_chars" = 200, "calibrated_ref_key" = NULL
WHERE "ref_storage_key" IS NULL AND "ref_source" IS NOT NULL;--> statement-breakpoint

-- An unrecognised source value would fall through presetToRequest's `=== 'locked'` test
-- into direction mode rather than erroring, so normalise before the CHECK lands.
UPDATE "voice_presets"
SET "ref_source" = 'upload'
WHERE "ref_source" IS NOT NULL AND "ref_source" NOT IN ('upload', 'locked');--> statement-breakpoint

ALTER TABLE "voice_presets" ADD CONSTRAINT "voice_presets_ref_source_pairs_with_clip" CHECK (("voice_presets"."ref_source" IS NULL) = ("voice_presets"."ref_storage_key" IS NULL));--> statement-breakpoint
ALTER TABLE "voice_presets" ADD CONSTRAINT "voice_presets_ref_source_known" CHECK ("voice_presets"."ref_source" IS NULL OR "voice_presets"."ref_source" IN ('upload', 'locked'));