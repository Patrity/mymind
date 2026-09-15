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

export function presetMode(p: Pick<VoicePresetDTO, 'instruction' | 'refStorageKey'>): VoiceMode {
  const hasInstruction = !!p.instruction?.trim()
  const hasRef = !!p.refStorageKey
  if (hasInstruction && hasRef) return 'direction'
  if (hasRef) return 'clone'
  if (hasInstruction) return 'design'
  return 'plain'
}
