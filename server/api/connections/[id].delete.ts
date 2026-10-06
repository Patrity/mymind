import { ConnectionError, deleteConnection } from '../../lib/google/manage'
import { requireSession } from '../../utils/auth-guard'

// Cycle 79: disconnect — revoke at Google (best effort), then delete the linked account row.
export default defineEventHandler(async (event) => {
  requireSession(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })
  try {
    return await deleteConnection(id)
  } catch (err) {
    if (err instanceof ConnectionError) throw createError({ statusCode: err.statusCode, statusMessage: err.message })
    throw err
  }
})
