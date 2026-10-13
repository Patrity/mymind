import { setCaseEnabled } from '@mymind/core/lib/eval/suites'
import { requireSession } from '../../../utils/auth-guard'
import { notFound, requireEvalId } from '../../../utils/evals-http'

/** The enable toggle: `{ enabled }`. Session only. */
export default defineEventHandler(async (event) => {
  requireSession(event)
  const id = requireEvalId(event, 'case')
  const body = (await readBody<{ enabled?: unknown }>(event)) ?? {}
  if (typeof body.enabled !== 'boolean') throw createError({ statusCode: 400, statusMessage: 'Invalid', data: { message: 'enabled must be true or false' } })
  const row = await setCaseEnabled(id, body.enabled)
  if (!row) throw notFound('case')
  return { id: row.id, enabled: row.enabled }
})
