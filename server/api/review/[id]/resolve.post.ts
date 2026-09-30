import { decideReview } from '../../../services/review-decisions'
import { isConflictResolution } from '../../../lib/review/conflict-resolution'

/**
 * Resolve a memory conflict one of four ways — see ConflictResolution. The resolution itself is
 * decideReview's (server/services/review-decisions.ts), shared with Bridget's decide_review.
 *
 * Separate from approve/reject rather than bolted onto them: those two are the generic
 * verbs every review kind implements, and a conflict has four outcomes, not two. Folding a
 * `resolution` body param into `approve` would have made "approve" mean "archive the new
 * one" for this kind alone.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { resolution } = await readBody<{ resolution?: unknown }>(event)
  if (!isConflictResolution(resolution)) {
    throw createError({ statusCode: 400, statusMessage: `Unknown resolution: ${String(resolution)}` })
  }

  const r = await decideReview(id, resolution, { route: true })
  if (!r.ok) {
    switch (r.reason) {
      case 'not_pending': throw createError({ statusCode: 404 })
      // A resolution on any other kind is not a choice that item has.
      case 'unknown_kind':
      case 'invalid_choice': throw createError({ statusCode: 400, statusMessage: `Not a memory conflict: ${r.kind}` })
      default: throw createError({ statusCode: 422, statusMessage: r.message })
    }
  }
  return { ok: true, resolution, archived: r.applied as string[] }
})
