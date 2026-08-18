import { z } from 'zod'
import { reorderColumns } from '../../services/task-columns'

const Body = z.object({ ids: z.array(z.uuid()).min(1) })

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  // reorderColumns already calls publishChange per id — don't double-emit here.
  await reorderColumns(parsed.data.ids)
  return { ok: true }
})
