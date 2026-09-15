import { createPreset, calibrateMaxSegmentChars, makeLiveProbe, loadReferenceBytes, updatePreset } from '../../services/voice-presets'
import type { PresetInput } from '../../services/voice-presets'

export default defineEventHandler(async (event) => {
  const body = await readBody<PresetInput>(event)
  if (!body?.name?.trim()) throw createError({ statusCode: 400, statusMessage: 'name is required' })
  const created = await createPreset(body)
  // Calibration costs a rig slot, so only reference-backed presets pay it (design presets
  // run ~40-token prompts and cannot approach the ceiling).
  if (created.refStorageKey) {
    const refAudio = await loadReferenceBytes(created)
    const max = await calibrateMaxSegmentChars(created, makeLiveProbe(created, refAudio))
    if (max !== created.maxSegmentChars) return updatePreset(created.id, { maxSegmentChars: max })
  }
  return created
})
