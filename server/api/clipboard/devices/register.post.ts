import { registerDevice } from '../../../services/clipboard'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({})) as { label?: string }
  const device = await registerDevice(body?.label)

  // Set the clip_device cookie so subsequent requests from this client carry
  // device attribution automatically. httpOnly: false so the client JS can
  // also read it (needed for the clipboard UI's "this device" labelling).
  setCookie(event, 'clip_device', device.id, {
    httpOnly: false,
    path: '/',
    maxAge: 60 * 60 * 24 * 365 * 10 // 10 years
  })

  return { id: device.id, label: device.label }
})
