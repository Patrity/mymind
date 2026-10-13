import { getSuiteDetail } from '@mymind/core/lib/eval/dashboard'
import { notFound, requireEvalId } from '../../../../utils/evals-http'

/** A suite: its cases and its runs (newest first). */
export default defineEventHandler(async (event) => {
  const view = await getSuiteDetail(requireEvalId(event, 'suite'))
  if (!view) throw notFound('suite')
  return view
})
