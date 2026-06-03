import { searchMemories, listMemories } from '../../services/memory'
import type { MemoryScope } from '../../../shared/types/memory'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const q = query.q as string | undefined
  const scope = query.scope as MemoryScope | undefined
  const reviewed = query.reviewed as string | undefined
  const limit = query.limit ? Number(query.limit) : undefined

  if (q?.trim()) {
    return searchMemories(q, { scope, limit })
  }

  const reviewedBool =
    reviewed === 'true' ? true : reviewed === 'false' ? false : undefined

  return listMemories({ scope, reviewed: reviewedBool, limit })
})
