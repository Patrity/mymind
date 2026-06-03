import { deleteThread } from '../../../../services/clipboard'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const deleted = await deleteThread(id)
  if (!deleted) throw createError({ statusCode: 404, statusMessage: 'Thread not found' })
  return { ok: true }
})
