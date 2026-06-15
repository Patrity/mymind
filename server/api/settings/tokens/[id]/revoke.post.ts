import { requireSession } from '../../../../utils/auth-guard'
import { revokeToken } from '../../../../services/api-tokens'

export default defineEventHandler(async (event) => {
  requireSession(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  return revokeToken(id)
})
