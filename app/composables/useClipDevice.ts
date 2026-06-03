// Ensures this browser is registered as a device for clipboard attribution.
// On mount: read the `clip_device` cookie; if absent, POST
// /api/clipboard/devices/register (label from a simple UA guess) which sets
// the cookie server-side; expose the device id reactively.
//
// SSR is a no-op — we'd be registering the server's UA which is useless.
// Single-user tool, so no toast rename prompt (simplified vs copipasta's
// useDevice which offered a rename link to /devices).
export function useClipDevice() {
  const cookie = useCookie<string | null>('clip_device')
  const deviceId = ref<string | null>(cookie.value ?? null)
  const ready = ref(!!cookie.value)

  async function ensureRegistered() {
    if (ready.value || import.meta.server) return
    if (cookie.value) {
      deviceId.value = cookie.value
      ready.value = true
      return
    }
    try {
      // Derive a simple label from the UA (platform + browser guess).
      const ua = navigator.userAgent
      const label = guessLabel(ua)
      const r = await $fetch<{ id: string, label: string }>('/api/clipboard/devices/register', {
        method: 'POST',
        body: { label }
      })
      // Server sets the cookie; mirror it into the reactive ref so the
      // clipboard UI can use it immediately without a page refresh.
      cookie.value = r.id
      deviceId.value = r.id
      ready.value = true
    } catch {
      // Non-fatal — device attribution will be anonymous for this session.
    }
  }

  return { deviceId, ready, ensureRegistered }
}

// --- helpers ---

function guessLabel(ua: string): string {
  // Best-effort platform + browser from UA string. Not exhaustive.
  let platform = 'Unknown'
  if (/iPhone/.test(ua)) platform = 'iPhone'
  else if (/iPad/.test(ua)) platform = 'iPad'
  else if (/Android/.test(ua)) platform = 'Android'
  else if (/Macintosh/.test(ua)) platform = 'Mac'
  else if (/Windows/.test(ua)) platform = 'Windows'
  else if (/Linux/.test(ua)) platform = 'Linux'

  let browser = ''
  if (/Edg\//.test(ua)) browser = ' · Edge'
  else if (/Chrome\//.test(ua)) browser = ' · Chrome'
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = ' · Safari'
  else if (/Firefox\//.test(ua)) browser = ' · Firefox'

  return `${platform}${browser}`
}
