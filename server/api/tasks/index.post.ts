import { z } from 'zod'
import { createTask } from '../../services/tasks'
import { publishChange } from '../../utils/live-bus'

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

  let dueDate: Date | null = null
  if (body.dueDate) {
    const d = new Date(body.dueDate)
    if (isNaN(d.getTime())) throw createError({ statusCode: 400, statusMessage: 'Invalid dueDate' })
    dueDate = d
  }

  const task = await createTask({
    ...body,
    dueDate
  })
  publishChange({ resource: 'task', action: 'created', id: task.id })
  return task
})
