// PUT /api/settings/self-improvement { mode } — sets Bridget's self-improvement mode (cycle 76).
// Only 'on' | 'review_only' | 'off' are accepted (400 otherwise). Session-only, like the GET.
import { z } from 'zod'
import { requireSession } from '../../utils/auth-guard'
import { getSelfImprovementMode, setSelfImprovementMode } from '@mymind/core/lib/agent/self-improvement-mode'

const Body = z.object({ mode: z.enum(['on', 'review_only', 'off']) })

export default defineEventHandler(async (event) => {
  requireSession(event)
  let mode: z.infer<typeof Body>['mode']
  try {
    ({ mode } = Body.parse(await readBody(event)))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  await setSelfImprovementMode(mode)
  return { mode: await getSelfImprovementMode() }
})
