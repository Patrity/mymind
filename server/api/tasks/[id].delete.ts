import { deleteTask } from '../../services/tasks'
import { publishChange } from '../../utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const ok = await deleteTask(id)
  if (!ok) throw createError({ statusCode: 404 })
  publishChange({ resource: 'task', action: 'deleted', id })
  return { ok: true }
})
