import { z } from 'zod'
import { searchMemories, listMemories } from '../../services/memory'
import { AUDIT_VERDICTS } from '../../lib/memory/extract-v3'
import { MEMORY_SORTS, type MemoryScope } from '../../../shared/types/memory'

// Score filters and sorts (cycle 77). An unknown value is a 400 rather than ignored: an ignored
// typo would silently return the unfiltered list.
const ScoreQuery = z.object({
  verdict: z.enum(AUDIT_VERDICTS).optional(),
  scored: z.enum(['yes', 'no']).optional(),
  disagree: z.enum(['1']).optional(),
  sort: z.enum(MEMORY_SORTS).optional()
})

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const q = query.q as string | undefined
  const scope = query.scope as MemoryScope | undefined
  const reviewed = query.reviewed as string | undefined
  const project = (query.project as string | undefined)?.trim() || undefined
  const limit = query.limit ? Number(query.limit) : undefined

  const parsed = ScoreQuery.safeParse({
    verdict: query.verdict || undefined,
    scored: query.scored || undefined,
    disagree: query.disagree || undefined,
    sort: query.sort || undefined
  })
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') })
  }
  const { verdict, scored, sort } = parsed.data
  const disagree = parsed.data.disagree === '1' || undefined

  // Search keeps its relevance order: score filters apply, `sort` does not.
  if (q?.trim()) {
    return searchMemories(q, { scope, project, limit, verdict, scored, disagree })
  }

  const reviewedBool =
    reviewed === 'true' ? true : reviewed === 'false' ? false : undefined

  return listMemories({ scope, reviewed: reviewedBool, project, limit, verdict, scored, disagree, sort })
})
