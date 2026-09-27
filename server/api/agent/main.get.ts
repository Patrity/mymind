import { getOrCreateMain } from '../../lib/agent/runtime/sessions'
import { getConversation } from '../../services/conversations'

/** The main thread, created on first request. The agent page opens this by default. */
export default defineEventHandler(async () => {
  const id = await getOrCreateMain()
  return getConversation(id)
})
