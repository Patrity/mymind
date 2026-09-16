// The four Breeze modes are a FUNCTION of which fields are populated — exactly how the
// rig picks its template. Never store a `mode` column: a stored mode can contradict the
// fields, a derived one cannot.
export type VoiceMode = 'plain' | 'design' | 'clone' | 'direction'

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
