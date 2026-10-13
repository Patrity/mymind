import { getCaseView } from '@mymind/core/lib/eval/dashboard'
import { updateCase } from '@mymind/core/lib/eval/suites'
import { requireSession } from '../../../utils/auth-guard'
import { evalError, notFound, requireEvalId } from '../../../utils/evals-http'

/** Saves a case from the editor (its whole JSON, validated like an import). 400 carries the zod
 *  issues by path so the editor pins each one to its field. Session only. */
export default defineEventHandler(async (event) => {
  requireSession(event)
  const id = requireEvalId(event, 'case')
  const body = await readBody(event)
  let row
  try {
    row = await updateCase(id, body)
  } catch (err) {
    throw evalError(err)
  }
  if (!row) throw notFound('case')
  return (await getCaseView(id))!
})
