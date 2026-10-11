import { z } from 'zod'
import { startWorkstream } from '@mymind/core/lib/agent/workstreams/loop'
import { BUDGET_LIMITS } from '@mymind/core/shared/types/workstreams'
import { workstreamError } from '../../utils/workstreams-http'

const Body = z.object({
  goal: z.string().trim().min(3).max(4000),
  budget: z.object({
    maxSteps: z.number().int().min(BUDGET_LIMITS.maxSteps.min).max(BUDGET_LIMITS.maxSteps.max).optional(),
    maxWallMs: z.number().int().min(BUDGET_LIMITS.maxWallMs.min).max(BUDGET_LIMITS.maxWallMs.max).optional()
  }).optional()
})

/**
 * Start a workstream from the UI (cycle 81 spec §5.5). The row and its first segment are written
 * here (the same `startWorkstream` the tool uses, cap of 3 included); the kick goes to the agent
 * worker, which is the only executor. No origin conversation: it was started from /workstreams.
 */
export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid workstream', data: { message: parsed.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } })
  }
  try {
    return await startWorkstream({ goal: parsed.data.goal, budget: parsed.data.budget, originConversationId: null })
  } catch (err) {
    throw workstreamError(err)
  }
})
