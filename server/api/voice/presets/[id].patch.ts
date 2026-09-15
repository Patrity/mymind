import { updatePreset, getPreset, calibrateMaxSegmentChars, makeLiveProbe, loadReferenceBytes } from '../../../services/voice-presets'
import type { PresetInput } from '../../../services/voice-presets'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<Partial<PresetInput>>(event)
  const before = await getPreset(id)
  if (!before) throw createError({ statusCode: 404, statusMessage: 'preset not found' })
  const updated = await updatePreset(id, body)
  // Recalibrate only when the reference actually changed — the cap depends on the clip,
  // not on the instruction or the sampling knobs.
  if (updated.refStorageKey && updated.refStorageKey !== before.refStorageKey) {
    const refAudio = await loadReferenceBytes(updated)
    const max = await calibrateMaxSegmentChars(updated, makeLiveProbe(updated, refAudio))
    if (max !== updated.maxSegmentChars) return updatePreset(id, { maxSegmentChars: max })
  }
  return updated
})
