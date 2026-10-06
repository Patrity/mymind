import { googleConfigured } from '../../lib/google/scopes'
import { listConnectionDTOs } from '../../lib/google/manage'
import { requireSession } from '../../utils/auth-guard'

// Cycle 79: Settings → Connections. Web session only — a machine token must never see or
// manage linked Google accounts. Tokens are never returned.
export default defineEventHandler(async (event) => {
  requireSession(event)
  return { configured: googleConfigured(), connections: await listConnectionDTOs() }
})
