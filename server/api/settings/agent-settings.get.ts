// GET /api/settings/agent-settings — Bridget's agent settings doc (cycle 84: judge / Smart Approvals),
// plus `problems`: the stored fields that were corrupt and read fail-closed (empty normally).
import { requireSession } from '../../utils/auth-guard'
import { readAgentSettingsWithProblems } from '@mymind/core/lib/agent/agent-settings'

export default defineEventHandler(async (event) => {
  requireSession(event)
  // Task 4 fix round 1 (M1): `problems` names any stored field read fail-closed (a corrupt row).
  return await readAgentSettingsWithProblems()
})
