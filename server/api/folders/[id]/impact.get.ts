import { z } from 'zod'
import { folderImpact } from '../../../services/folders'

const Query = z.object({ to: z.string().optional() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const parsed = Query.safeParse(getQuery(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  // Read-only: folderImpact reports zeros for an unknown id rather than failing, since the UI
  // dialog it feeds needs a shape, not an error, while the user is still choosing a destination.
  return folderImpact(id, parsed.data.to)
})
