import { importSuite } from '@mymind/core/lib/eval/suites'
import { requireSession } from '../../../utils/auth-guard'
import { evalError, IMPORT_BODY_MAX, readJsonBody } from '../../../utils/evals-http'

/** Imports (upserts) a suite from its JSON: `{ suite, replace? }`. Session only — a token can read
 *  the dashboard but never change what Bridget is measured against. */
export default defineEventHandler(async (event) => {
  requireSession(event)
  const body = (await readJsonBody(event, IMPORT_BODY_MAX)) as { suite?: unknown, replace?: unknown }
  try {
    return await importSuite(body.suite, { replace: body.replace === true })
  } catch (err) {
    throw evalError(err)
  }
})
