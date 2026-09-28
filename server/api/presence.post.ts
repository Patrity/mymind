import { markActive } from '../lib/channels/presence'
import { requireSession } from '../utils/auth-guard'

// Activity ping from app/plugins/presence.client.ts (throttled client-side to 1/min). Web
// session only: a machine client (API token / OAuth) pinging would mark Tony present and
// silently suppress his texts.
export default defineEventHandler((event) => {
  requireSession(event)

  markActive()
  setResponseStatus(event, 204)
  return null
})
