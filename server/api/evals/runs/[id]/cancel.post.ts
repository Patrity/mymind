import { cancelEvalRun } from '@mymind/core/lib/eval/runs'
import { requireSession } from '../../../../utils/auth-guard'
import { requireEvalId } from '../../../../utils/evals-http'

/** Cancels a queued / running run (it stops at its next heartbeat; results so far are kept). */
export default defineEventHandler(async (event) => {
  requireSession(event)
  return { cancelled: await cancelEvalRun(requireEvalId(event, 'run')) }
})
