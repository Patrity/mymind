import { getAttemptView } from '@mymind/core/lib/eval/dashboard'
import { notFound, requireEvalId } from '../../../utils/evals-http'

/** One attempt in full: tool log, scoring, captured writes, approvals, verdict, final text — and
 *  its case as it is now (flagged when edited after the run). */
export default defineEventHandler(async (event) => {
  const view = await getAttemptView(requireEvalId(event, 'attempt'))
  if (!view) throw notFound('attempt')
  return view
})
