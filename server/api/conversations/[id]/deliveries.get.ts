import { z } from 'zod'
import { conversationDeliveries } from '../../../services/conversations'
import { requireSession } from '../../../utils/auth-guard'

// GET /api/conversations/:id/deliveries → [{ messageId, channel, status }] (cycle 75). Web session
// only, like the rest of the channels surface.
// /agent's live refresh of the delivery badges: its transcript is not a vue-query read, so the
// `channelDelivery` live event (which invalidates the ['conversation'] prefix) reaches it through
// this small query instead of a full re-read of the thread.
export default defineEventHandler(async (event) => {
  requireSession(event)
  const id = z.uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) throw createError({ statusCode: 400, statusMessage: 'Invalid conversation id' })
  return conversationDeliveries(id.data)
})
