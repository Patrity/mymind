// PUT /api/settings/agent-settings — patch Bridget's agent settings doc (cycle 84: judge / Smart
// Approvals; cycle 85: eval knobs; cycle 86: taintConfinement). Body: any subset of { judge: {
// enabled, smartApprovals: { workstreams, chat }, confidence (0.5–0.99), maxInFlight }, eval: {…},
// taintConfinement: boolean }; unknown or invalid fields → 400. Session-only.
import { ZodError } from 'zod'
import { requireSession } from '../../utils/auth-guard'
import { saveAgentSettings } from '@mymind/core/lib/agent/agent-settings'
import { invalidateWorkerCache } from '@mymind/core/lib/bus/invalidate'

export default defineEventHandler(async (event) => {
  requireSession(event)
  const body = await readBody(event)
  let saved
  try {
    saved = await saveAgentSettings(body)
  } catch (err) {
    if (err instanceof ZodError) throw createError({ statusCode: 400, statusMessage: 'Invalid agent settings', data: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') })
    throw err
  }
  // apps/worker keeps its own copy (cycle 81, spec §3.6).
  await invalidateWorkerCache('agent-settings')
  return saved
})
