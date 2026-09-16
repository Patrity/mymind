import { deletePreset } from '../../../services/voice-presets'

export default defineEventHandler(async (event) => {
  await deletePreset(getRouterParam(event, 'id')!)
  return { ok: true }
})
