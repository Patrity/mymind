import { markActive } from '../lib/channels/presence'

// Session-authed activity ping from app/plugins/presence.client.ts (throttled client-side to 1/min).
export default defineEventHandler((event) => {
  markActive()
  setResponseStatus(event, 204)
  return null
})
