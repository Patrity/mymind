import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, boolean, timestamp, real, index, uniqueIndex, check } from 'drizzle-orm/pg-core'

// A Breeze voice. Mode (plain|design|clone|direction) is DERIVED from which fields are
// populated — see shared/types/voice-presets.ts presetMode(). Deliberately not a column:
// a stored mode can contradict the fields it claims to describe.
export const voicePresets = pgTable('voice_presets', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  instruction: text('instruction'),
  cfgScale: real('cfg_scale').notNull().default(4),
  seed: integer('seed').notNull().default(42),
  temperature: real('temperature').notNull().default(0.9),
  topP: real('top_p').notNull().default(1),
  topK: integer('top_k').notNull().default(50),
  refStorageKey: text('ref_storage_key'),
  refText: text('ref_text'),
  refDurationMs: integer('ref_duration_ms'),
  maxSegmentChars: integer('max_segment_chars').notNull().default(200),
  // WHICH reference clip `max_segment_chars` was actually measured against, or NULL for
  // "never measured". The cap column cannot answer that on its own: it is NOT NULL
  // DEFAULT 200, so a row that was never probed is indistinguishable from one measured at
  // 200 — and a calibration that failed (rig down, 409) would then be assumed done forever.
  // Holding the KEY rather than a flag also makes the marker self-invalidating: swap the
  // clip and the cap is, correctly, no longer measured for it.
  calibratedRefKey: text('calibrated_ref_key'),
  // Seeds the user chose to keep. Casting a designed voice is a lottery — the same
  // description at a different seed is a different person — so without somewhere to put a
  // good result, the next roll of the dice loses it.
  starredSeeds: integer('starred_seeds').array().notNull().default(sql`'{}'::integer[]`),
  // Where the reference clip came from, and therefore how the voice should be spoken.
  //   'upload' — a clip the user supplied. The instruction still steers delivery
  //              (direction mode), because steering is why they wrote one.
  //   'locked' — a render of THIS preset's own description, frozen deliberately. The
  //              instruction is already expressed in the clip, so re-applying it only
  //              fights the reference; these speak as a pure clone.
  // Null whenever there is no reference at all.
  refSource: text('ref_source'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, t => [
  uniqueIndex('voice_presets_name_key').on(t.name),
  // Exactly one default. The voice cookie resolves to "the default preset" whenever its
  // stored id is missing (deleted preset, fresh browser), so losing the default leaves
  // the agent with nothing to speak with.
  uniqueIndex('voice_presets_one_default').on(t.isDefault).where(sql`is_default`),
  index('voice_presets_name_idx').on(t.name),
  // cfg_scale > 1 needs an instruction: without one Breeze has no negative prompt and
  // answers 500 with an opaque body. Enforced here because a bad row is not a
  // mis-render, it is every utterance from that preset failing.
  check('voice_presets_cfg_needs_instruction',
    sql`${t.cfgScale} <= 1 OR (${t.instruction} IS NOT NULL AND btrim(${t.instruction}) <> '')`),
  check('voice_presets_cfg_positive', sql`${t.cfgScale} > 0`),
  // A reference without its transcript is the same class of guaranteed-500.
  check('voice_presets_ref_needs_text',
    sql`${t.refStorageKey} IS NULL OR (${t.refText} IS NOT NULL AND btrim(${t.refText}) <> '')`),
  // A clip and its provenance exist together or not at all. Both halves of this shipped as
  // real bugs while `ref_source` was written only by the lock/unlock routes and the clip
  // fields only by Save:
  //   clip, no source  — derives as `direction`, so the voice is spoken with its instruction
  //                      re-applied over a reference that already contains it
  //   source, no clip  — the studio reported a locked voice with nothing frozen and never
  //                      offered Lock again
  // The client now writes all four fields as one tuple (studio.ts ReferenceFields); this is
  // the backstop that makes the broken pair unconstructable rather than merely unwritten.
  check('voice_presets_ref_source_pairs_with_clip',
    sql`(${t.refSource} IS NULL) = (${t.refStorageKey} IS NULL)`),
  // Only the two values the synthesis path knows how to speak. A typo here would silently
  // fall through presetToRequest's `refSource === 'locked'` test into direction mode.
  check('voice_presets_ref_source_known',
    sql`${t.refSource} IS NULL OR ${t.refSource} IN ('upload', 'locked')`)
])

export type VoicePresetRow = typeof voicePresets.$inferSelect
