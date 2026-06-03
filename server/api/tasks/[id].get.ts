import { getTask } from '../../services/tasks'

export default defineEventHandler(async (event) => {
  const task = await getTask(getRouterParam(event, 'id')!)
  if (!task) throw createError({ statusCode: 404 })
  return task
})
