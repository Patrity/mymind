import { conversationDeliveries } from '../../../services/conversations'

// GET /api/conversations/:id/deliveries → [{ messageId, channel, status }] (cycle 75).
// /agent's live refresh of the delivery badges: its transcript is not a vue-query read, so the
// `channelDelivery` live event (which invalidates the ['conversation'] prefix) reaches it through
// this small query instead of a full re-read of the thread.
export default defineEventHandler(async (event) => {
  return conversationDeliveries(getRouterParam(event, 'id')!)
})
