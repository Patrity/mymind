import { loadChannelsConfig, resendReady } from '@mymind/core/lib/channels/config'
import { currentImessageHealth } from '@mymind/core/lib/channels/health'
import { requireSession } from '../../utils/auth-guard'

// GET /api/channels/status — the Settings → Channels nav dot (cycle 75). iMessage health is the
// last catch-up health check (every 2 min, or forced by POST /api/settings/channels/test-imessage),
// read from whichever process runs the catch-up (cycle 81: the worker publishes it with its heartbeat);
// no request to BlueBubbles is made here. Nothing secret: no URL, password or token. Web session
// only, like the rest of the channels surface.
export default defineEventHandler(async (event) => {
  requireSession(event)
  const c = await loadChannelsConfig()
  const h = await currentImessageHealth()
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
