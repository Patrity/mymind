import { markActive } from '@mymind/core/lib/channels/presence'
import { sendCommand } from '@mymind/core/lib/bus/commands'
import { requireSession } from '../utils/auth-guard'

// Activity ping from app/plugins/presence.client.ts (throttled client-side to 1/min). Web
// session only: a machine client (API token / OAuth) pinging would mark Tony present and
// silently suppress his texts.
// Recorded here AND sent to apps/worker (cycle 81, spec §3.6): the worker's deliveries decide
// whether Tony is away (isAway), so the worker must hold the same last-activity time.
export default defineEventHandler(async (event) => {
  requireSession(event)

  const at = Date.now()
  markActive(at)
  await sendCommand('presence', { lastActiveAt: at }).catch(err => console.error('[presence] sending presence to the worker failed:', err))
  setResponseStatus(event, 204)
  return null
})
