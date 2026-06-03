import { z } from 'zod'
import { updateTask } from '../../services/tasks'

// Accept both ISO datetime strings and bare YYYY-MM-DD from <input type=date>
const Body = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  dueDate: z.string().nullish(),
  project: z.string().nullish(),
  order: z.number().int().optional()
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  const { dueDate, ...rest } = body
  const task = await updateTask(getRouterParam(event, 'id')!, {
    ...rest,
    // Only include dueDate when it was explicitly provided in the body
    ...(dueDate !== undefined ? { dueDate: dueDate ? new Date(dueDate) : null } : {})
  })
  if (!task) throw createError({ statusCode: 404 })
  return task
})
