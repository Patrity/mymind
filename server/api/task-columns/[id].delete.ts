import { z } from 'zod'
import { deleteColumn } from '../../services/task-columns'

const Body = z.object({
  mode: z.enum(['delete', 'reassign']),
  targetColumnId: z.uuid().optional()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  const result = await deleteColumn(id, parsed.data)
  // A refusal (last column of its kind, missing target, etc.) is a deliberate, explainable
  // no-op — surface it as a 409 with the service's reason as statusMessage so the UI can
  // render it inline, not a generic 500. deleteColumn already calls publishChange on success.
  if (!result.ok) {
    throw createError({ statusCode: 409, statusMessage: result.reason ?? 'cannot delete column' })
  }
  return result
})
