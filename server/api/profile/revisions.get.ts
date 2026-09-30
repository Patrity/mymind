// GET /api/profile/revisions — revision history of the "About Tony" profile.
import { requireSession } from '../../utils/auth-guard'
import { listProfileRevisions } from '../../services/profile'

export default defineEventHandler(async (event) => {
  requireSession(event)
  return listProfileRevisions()
})
