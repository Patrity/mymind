import { z } from 'zod'
import { enqueueEvalRun, evalRunDTO } from '@mymind/core/lib/eval/runs'
import { requireSession } from '../../../../utils/auth-guard'
import { evalError, readJsonBody, requireEvalId, SMALL_BODY_MAX } from '../../../../utils/evals-http'

const RunBody = z.object({
  cases: z.array(z.string().min(1).max(80)).max(500).optional(),
  n: z.number().int().optional(),
  model: z.string().min(1).max(200).optional()
})

/** Runs a suite (the worker's `eval:run-suite` job): `{ cases?, n?, model? }`. Session only — a run
 *  spends real model calls. */
export default defineEventHandler(async (event) => {
  requireSession(event)
  const suiteId = requireEvalId(event, 'suite')
  try {
    const params = RunBody.parse(await readJsonBody(event, SMALL_BODY_MAX))
    return evalRunDTO(await enqueueEvalRun(suiteId, params))
  } catch (err) {
    throw evalError(err)
  }
})
