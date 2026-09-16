import { updatePreset, getPreset, ensureCalibrated, withoutCalibrationFields } from '../../../services/voice-presets'
import type { PresetInput } from '../../../services/voice-presets'
import type { SavedPresetDTO } from '../../../../shared/types/voice-presets'

export default defineEventHandler(async (event): Promise<SavedPresetDTO> => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<Partial<PresetInput>>(event)
  if (!await getPreset(id)) throw createError({ statusCode: 404, statusMessage: 'preset not found' })
  // The cap and its provenance are measurements, never request fields.
  const updated = await updatePreset(id, withoutCalibrationFields(body))
  // Calibration decides for itself whether there is anything to measure: a reference that
  // is new OR whose last probe never completed gets one, a removal resets the cap, and an
  // already-measured clip costs no rig slot. A rig that cannot answer comes back as a
  // warning on a saved row rather than a 500 over a row that was written anyway.
  const { preset, calibrationWarning } = await ensureCalibrated(updated)
  return { ...preset, calibrationWarning }
})
