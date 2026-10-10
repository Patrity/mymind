import { getConversation } from '@mymind/core/services/conversations'

export default defineEventHandler(async (event) => {
  const r = await getConversation(getRouterParam(event, 'id')!)
  if (!r) throw createError({ statusCode: 404 })
  return r
})
