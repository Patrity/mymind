import { deleteConversation } from '@mymind/core/services/conversations'
import { publishChange } from '@mymind/core/utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await deleteConversation(id)
  publishChange({ resource: 'conversation', action: 'deleted', id })
  return { ok: true }
})
