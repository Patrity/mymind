import { z } from 'zod'
import { createColumn } from '../../services/task-columns'
import { TASK_COLUMN_KINDS, TASK_COLUMN_COLORS } from '../../../shared/types/task-columns'

const Body = z.object({
  name: z.string().min(1),
  kind: z.enum(TASK_COLUMN_KINDS),
  color: z.enum(TASK_COLUMN_COLORS),
  position: z.number().int().optional()
})

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  // createColumn (server/services/task-columns.ts) already calls publishChange on success —
  // don't double-emit here.
  return createColumn(parsed.data)
})
