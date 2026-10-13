import { getRunView } from '@mymind/core/lib/eval/dashboard'
import { notFound, requireEvalId } from '../../../utils/evals-http'

/** A run: provenance, summary (live while it runs), its cases and their attempts (light). */
export default defineEventHandler(async (event) => {
  const view = await getRunView(requireEvalId(event, 'run'))
  if (!view) throw notFound('run')
  return view
})
