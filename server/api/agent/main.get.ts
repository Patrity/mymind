import { getOrCreateMain } from '@mymind/core/lib/agent/runtime/sessions'
import { getConversation } from '@mymind/core/services/conversations'

/** The main thread, created on first request. The agent page opens this by default. */
export default defineEventHandler(async () => {
  const id = await getOrCreateMain()
  return getConversation(id)
})
