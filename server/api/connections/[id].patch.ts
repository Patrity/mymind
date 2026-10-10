import { ConnectionError, renameConnection } from '@mymind/core/lib/google/manage'
import { requireSession } from '../../utils/auth-guard'

// Cycle 79: rename a connection's label (the name Bridget's tools take as `account`).
export default defineEventHandler(async (event) => {
  requireSession(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })
  const body = await readBody<{ label?: unknown }>(event)
  try {
    return await renameConnection(id, body?.label)
  } catch (err) {
    if (err instanceof ConnectionError) throw createError({ statusCode: err.statusCode, statusMessage: err.message })
    throw err
  }
})
