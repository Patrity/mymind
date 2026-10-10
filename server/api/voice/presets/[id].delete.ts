import { deletePreset } from '@mymind/core/services/voice-presets'

export default defineEventHandler(async (event) => {
  await deletePreset(getRouterParam(event, 'id')!)
  return { ok: true }
})
