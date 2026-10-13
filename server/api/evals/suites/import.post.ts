import { importSuite } from '@mymind/core/lib/eval/suites'
import { requireSession } from '../../../utils/auth-guard'
import { evalError } from '../../../utils/evals-http'

/** Imports (upserts) a suite from its JSON: `{ suite, replace? }`. Session only — a token can read
 *  the dashboard but never change what Bridget is measured against. */
export default defineEventHandler(async (event) => {
  requireSession(event)
  const body = (await readBody<{ suite?: unknown, replace?: unknown }>(event)) ?? {}
  try {
    return await importSuite(body.suite, { replace: body.replace === true })
  } catch (err) {
    throw evalError(err)
  }
})
