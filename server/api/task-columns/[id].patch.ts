import { z } from 'zod'
import { updateColumn } from '../../services/task-columns'
import { TASK_COLUMN_COLORS } from '../../../shared/types/task-columns'

// `kind` is deliberately not accepted here — it's set once at creation. Changing it after the
// fact would let a column drift out from under is_default/kindForStatus resolution, which is
// exactly the structural risk Step 0's CHECK constraint exists to contain.
const Body = z.object({
  name: z.string().min(1).optional(),
  color: z.enum(TASK_COLUMN_COLORS).optional()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))
  try {
    // updateColumn already calls publishChange on success — don't double-emit here.
    return await updateColumn(id, body)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('no such column')) throw createError({ statusCode: 404, statusMessage: msg })
    throw err
  }
})
