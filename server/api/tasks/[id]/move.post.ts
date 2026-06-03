import { z } from 'zod'
import { moveTask } from '../../../services/tasks'

const Body = z.object({
  status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional(),
  order: z.number().int().optional()
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  const task = await moveTask(getRouterParam(event, 'id')!, body)
  if (!task) throw createError({ statusCode: 404 })
  return task
})
