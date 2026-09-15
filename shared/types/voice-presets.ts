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
   *  prompt-ceiling truncation. Calibrated on save for reference-backed presets. */
  maxSegmentChars: number
  isDefault: boolean
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
