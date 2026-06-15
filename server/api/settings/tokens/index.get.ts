import { requireSession } from '../../../utils/auth-guard'
import { listTokens } from '../../../services/api-tokens'

export default defineEventHandler(async (event) => {
  requireSession(event)
  return listTokens()
})
