import { createPreset, ensureCalibrated, withoutCalibrationFields } from '../../services/voice-presets'
import type { PresetInput } from '../../services/voice-presets'
import type { SavedPresetDTO } from '../../../shared/types/voice-presets'

export default defineEventHandler(async (event): Promise<SavedPresetDTO> => {
  const body = await readBody<PresetInput>(event)
  if (!body?.name?.trim()) throw createError({ statusCode: 400, statusMessage: 'name is required' })
  // A new row is never calibrated, whatever the body claims — Duplicate copies a
  // reference clip, and the cap measured for the ORIGINAL is not transferable: the
  // instruction shares the same prompt budget, so a copy with different text has a
  // different ceiling.
  const created = await createPreset(withoutCalibrationFields(body))
  // Calibration costs a rig slot, so only reference-backed presets pay it (design presets
  // run ~40-token prompts and cannot approach the ceiling). It cannot fail the request:
  // throwing here used to leave the caller with a 500 and no idea a row had been created.
  const { preset, calibrationWarning } = await ensureCalibrated(created)
  return { ...preset, calibrationWarning }
})
