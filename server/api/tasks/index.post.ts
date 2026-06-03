import { z } from 'zod'
import { createTask } from '../../services/tasks'

// Accept both ISO datetime strings and bare YYYY-MM-DD from <input type=date>
const Body = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  dueDate: z.string().nullish(),
  project: z.string().nullish()
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  return createTask({
    ...body,
    dueDate: body.dueDate ? new Date(body.dueDate) : null
  })
})
