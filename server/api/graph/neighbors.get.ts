// Nearest semantic neighbors of a node. Auth-gated by server/middleware/auth.ts
// (only logged-in sessions / API tokens reach here) — same implicit guard as
// index.get.ts; no explicit call needed. Raw vectors never leave getNeighbors.
import { z } from 'zod'
import { getNeighbors } from '../../services/graph'

// Kept in sync with shared/types/graph.ts GraphNodeType by hand — zod needs a runtime
// list, not just a type.
const Query = z.object({
  type: z.enum(['memory', 'document', 'image', 'session', 'project']),
  id: z.uuid(),
  k: z.coerce.number().int().optional()
})

export default defineEventHandler(async (event) => {
  const parsed = Query.safeParse(getQuery(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  const { type, id, k } = parsed.data
  return getNeighbors(type, id, Math.min(20, k || 8))
})
