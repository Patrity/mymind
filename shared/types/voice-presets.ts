// The four Breeze modes are a FUNCTION of which fields are populated — exactly how the
// rig picks its template. Never store a `mode` column: a stored mode can contradict the
// fields, a derived one cannot.
export type VoiceMode = 'plain' | 'design' | 'clone' | 'direction'

/** 'upload' = a clip the user supplied; 'locked' = a frozen render of this preset's own
 *  description. Null when the preset has no reference. */
export type RefSource = 'upload' | 'locked' | null

export interface VoicePresetDTO {
  id: string
  name: string
  instruction: string | null
  cfgScale: number
  seed: number
  temperature: number
  topP: number
  topK: number
  refStorageKey: string | null
  refText: string | null
  refDurationMs: number | null
  /** Longest text (in characters) this preset is known to synthesize without the
   *  prompt-ceiling truncation. Calibrated on save for reference-backed presets.
   *  Meaningful ONLY when `calibratedRefKey` matches `refStorageKey` — otherwise it is
   *  an unmeasured default (200, reference-free) or a conservative floor (100, a clone
   *  whose probe could not run). */
  maxSegmentChars: number
  /** Seeds kept for this voice, ascending. See toggleStarredSeed. */
  starredSeeds: number[]
  /** How this preset got its reference clip, and so how it is spoken. See the column
   *  comment in server/db/schema/voice-presets.ts. */
  refSource: RefSource
  /** The reference clip `maxSegmentChars` was measured against, or null for "never
   *  measured". A reference-free preset is never calibrated and never needs to be: it
   *  runs a ~40-token prompt and cannot approach the ceiling. */
  calibratedRefKey: string | null
  isDefault: boolean
}

/**
 * What POST/PATCH return: the saved row, plus whatever calibration could not do.
 *
 * Calibration is a live call to the rig, and the rig can be down, busy, or (in prod,
 * until the registry repoint) not wired up at all. That must not fail the save — losing
 * the row and telling the user only "500" was worse than useless — but it must not pass
 * silently either, because the outcome is a clone-backed voice running on an unmeasured
 * cap. So the save succeeds, the row stays visibly uncalibrated, and this sentence says so.
 */
export interface SavedPresetDTO extends VoicePresetDTO {
  calibrationWarning: string | null
}

/** True when this preset's cap is a measurement rather than an assumption. A preset with
 *  no reference is trivially "calibrated": there is nothing to measure. */
export function isCalibrated(p: Pick<VoicePresetDTO, 'refStorageKey' | 'calibratedRefKey'>): boolean {
  return !p.refStorageKey || p.calibratedRefKey === p.refStorageKey
}

/**
 * Ad-hoc synthesis parameters for ONE request. Merged over a resolved preset IN MEMORY
 * and never written back — auditioning a seed or previewing an unsaved slider is a
 * preview, not an edit.
 *
 * The allow-list is the point. `maxSegmentChars` is absent because it is CALIBRATED: a
 * caller must not be able to claim a larger prompt budget than the preset was measured
 * for. The reference fields are absent because a clip is what the calibration was
 * measured against, and pointing a request at a different one silently invalidates it.
 */
export interface SpeakOverrides {
  seed?: number
  instruction?: string | null
  cfgScale?: number
  temperature?: number
  topP?: number
  topK?: number
}

export function presetMode(p: Pick<VoicePresetDTO, 'instruction' | 'refStorageKey'>): VoiceMode {
  const hasInstruction = !!p.instruction?.trim()
  const hasRef = !!p.refStorageKey
  if (hasInstruction && hasRef) return 'direction'
  if (hasRef) return 'clone'
  if (hasInstruction) return 'design'
  return 'plain'
}

// ── Prompt ceiling ───────────────────────────────────────────────────────────────────
// Shared deliberately: the studio predicts how a render will be split and the server does
// the splitting. If those two disagreed, the UI would confidently describe something the
// route did not do — so they read the same function.
//
// Measured on the rig in design mode at cfg 4.0, one instruction and one seed held constant:
//
//      600 chars ->  19.0 s = 31.6 chars/sec    healthy
//      900 chars ->  21.5 s = 41.9 chars/sec    healthy
//     1000 chars -> 105.6 s =  9.5 chars/sec    RUNAWAY
//     1100 chars -> 120.0 s =  9.2 chars/sec    RUNAWAY (hit the rig's 120s output cap)
//
// Past the break the model stops tracking the text and rambles until the cap, returning a
// COMPLETE body — so nothing downstream can detect it from bytes. The break sits near 1080
// total prompt characters (900 text + an 80-char instruction); 950 keeps a margin, because
// it was located to +/-100 and a different instruction changes the token mix.

export const DESIGN_PROMPT_BUDGET = 950

/** Never plan a segment shorter than this, however long the instruction — below it the text
 *  is chopped so finely the seams cost more than the ceiling ever would. */
export const MIN_SEGMENT_CHARS = 120

/**
 * Longest single Breeze call this preset can take, in characters of TEXT.
 *
 * A reference-backed preset uses its calibrated cap verbatim: the clip rides in every prompt
 * and was measured against that exact budget, so extending it would hand the rig a prompt
 * nobody proved it can take. A reference-free preset has no calibration, so its ceiling comes
 * from the budget minus the instruction it carries — the two share one prompt.
 */
export function maxCallChars(preset: {
  instruction: string | null
  refStorageKey: string | null
  maxSegmentChars: number
}): number {
  if (preset.refStorageKey) return preset.maxSegmentChars
  const instructionCost = preset.instruction?.trim().length ?? 0
  return Math.max(MIN_SEGMENT_CHARS, DESIGN_PROMPT_BUDGET - instructionCost)
}
