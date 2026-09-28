import { loadChannelsConfig, resendReady } from '../../lib/channels/config'
import { lastHealth } from '../../lib/channels/inbound'
import { requireSession } from '../../utils/auth-guard'

// GET /api/channels/status — the Settings → Channels nav dot (cycle 75). iMessage health is the
// last catch-up health check (every 2 min, or forced by POST /api/settings/channels/test-imessage);
// no request to BlueBubbles is made here. Nothing secret: no URL, password or token. Web session
// only, like the rest of the channels surface.
export default defineEventHandler(async (event) => {
  requireSession(event)
  const c = await loadChannelsConfig()
  const h = lastHealth()
  return {
    imessage: {
      enabled: c.imessage.enabled,
      ok: h.ok,
      privateApi: h.privateApi,
      checkedAt: h.checkedAt,
      ...(h.error ? { error: h.error } : {})
    },
    email: { enabled: c.email.enabled, ready: await resendReady() }
  }
})
