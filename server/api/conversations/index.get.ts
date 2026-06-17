import { listConversations } from '../../services/conversations'

export default defineEventHandler(async (event) => {
  const q = getQuery(event).q as string | undefined
  return listConversations({ q: q?.trim() || undefined })
})
