// server/api/triage/[id]/revert.post.ts
import { revertTriageAction } from '../../../services/triage'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  // revertTriageAction handles its own failure modes (missing row, already reverted,
  // actuator error) and always resolves { ok, reason } with a 200 — mirrors
  // POST /api/agent/undo's contract for runUndo.
  return revertTriageAction(id)
})
