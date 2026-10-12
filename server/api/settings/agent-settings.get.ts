// GET /api/settings/agent-settings — Bridget's agent settings doc (cycle 84: judge / Smart Approvals).
import { requireSession } from '../../utils/auth-guard'
import { getAgentSettings } from '@mymind/core/lib/agent/agent-settings'

export default defineEventHandler(async (event) => {
  requireSession(event)
  return await getAgentSettings()
})
