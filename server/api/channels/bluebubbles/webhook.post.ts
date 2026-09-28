// POST /api/channels/bluebubbles/webhook?token=<t> — BlueBubbles' new-message / updated-message
// webhook. Exempt from session auth (server/middleware/auth.ts); the token in the URL is the
// credential, compared in constant time. A wrong or missing token, or iMessage disabled → 404.
// After that check it ALWAYS answers 200 — even when handling fails — so BlueBubbles never
// retries into a loop; a message lost here is picked up by the periodic catch-up.
import { verifyWebhookToken } from '../../../lib/channels/config'
import { parseWebhook } from '../../../lib/channels/bluebubbles/parse'
import { handleInbound } from '../../../lib/channels/inbound'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const token = typeof q.token === 'string' ? q.token : undefined
  if (!(await verifyWebhookToken(token))) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  try {
    const { event: ev } = parseWebhook(await readBody(event))
    if (!ev) return { ok: true }
    const outcome = await handleInbound(ev)
    return { ok: true, outcome }
  } catch (err) {
    console.error('[channels] BlueBubbles webhook failed:', err)
    return { ok: false }
  }
})
