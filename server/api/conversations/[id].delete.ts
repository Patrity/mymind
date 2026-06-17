import { deleteConversation } from '../../services/conversations'
import { publishChange } from '../../utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await deleteConversation(id)
  publishChange({ resource: 'conversation', action: 'deleted', id })
  return { ok: true }
})
