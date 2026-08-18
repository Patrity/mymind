import { z } from 'zod'
import { listTasks } from '../../services/tasks'

const Query = z.object({
  status: z.enum(['todo', 'in_progress', 'completed', 'blocked']).optional(),
  project: z.string().optional(),
  columnId: z.uuid().optional()
})

export default defineEventHandler(async (event) => {
  const parsed = Query.safeParse(getQuery(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  return listTasks(parsed.data)
})
