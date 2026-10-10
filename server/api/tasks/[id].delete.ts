import { deleteTask } from '@mymind/core/services/tasks'
import { publishChange } from '@mymind/core/utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const ok = await deleteTask(id)
  if (!ok) throw createError({ statusCode: 404 })
  publishChange({ resource: 'task', action: 'deleted', id })
  return { ok: true }
})
