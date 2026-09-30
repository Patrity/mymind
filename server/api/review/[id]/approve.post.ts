import { decideReview } from '../../../services/review-decisions'
import { SELF_IMPROVEMENT_CONFLICT } from '../kinds'

// A thin wrapper over decideReview (server/services/review-decisions.ts), the path Bridget's
// decide_review tool shares. `route: true` keeps this endpoint's historical contract: review_queue
// ids only, and `approve` accepted for every kind with a handler.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const r = await decideReview(id, 'approve', { route: true })
  if (!r.ok) {
    switch (r.reason) {
      case 'unknown_kind': throw createError({ statusCode: 400, statusMessage: `Unknown review kind: ${r.kind}` })
      case 'conflict': throw createError({ statusCode: 409, message: SELF_IMPROVEMENT_CONFLICT, data: { current: r.current, summary: SELF_IMPROVEMENT_CONFLICT } })
      case 'apply_failed': throw createError({ statusCode: 422, message: r.message, data: { summary: r.message } })
      default: throw createError({ statusCode: 404 })
    }
  }

  // Only approveTriage (kind: 'triage') returns `applied`; only approveAgentAction (kind:
  // 'agent-action') and approveSelfImprovement return `undoToken`/`summary`. Other kinds have
  // nothing to report — those fields stay undefined for them.
  return { ok: true, applied: r.result?.applied, undoToken: r.result?.undoToken, summary: r.result?.summary }
})
