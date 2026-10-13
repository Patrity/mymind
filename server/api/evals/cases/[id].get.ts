import { getCaseView } from '@mymind/core/lib/eval/dashboard'
import { notFound, requireEvalId } from '../../../utils/evals-http'

/** A case's JSON for the editor. */
export default defineEventHandler(async (event) => {
  const view = await getCaseView(requireEvalId(event, 'case'))
  if (!view) throw notFound('case')
  return view
})
