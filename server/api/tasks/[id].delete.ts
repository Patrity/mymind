import { deleteTask } from '../../services/tasks'

export default defineEventHandler(async (event) => {
  const ok = await deleteTask(getRouterParam(event, 'id')!)
  if (!ok) throw createError({ statusCode: 404 })
  return { ok: true }
})
