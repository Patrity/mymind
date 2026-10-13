import { exportSuite } from '@mymind/core/lib/eval/suites'
import { notFound, requireEvalId } from '../../../../utils/evals-http'

/** The suite as import-ready JSON. */
export default defineEventHandler(async (event) => {
  const json = await exportSuite(requireEvalId(event, 'suite'))
  if (!json) throw notFound('suite')
  return json
})
