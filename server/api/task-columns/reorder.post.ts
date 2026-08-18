import { z } from 'zod'
import { reorderColumns } from '../../services/task-columns'

const Body = z.object({ ids: z.array(z.uuid()).min(1) })

export default defineEventHandler(async (event) => {
  const { ids } = Body.parse(await readBody(event))
  // reorderColumns already calls publishChange per id — don't double-emit here.
  await reorderColumns(ids)
  return { ok: true }
})
