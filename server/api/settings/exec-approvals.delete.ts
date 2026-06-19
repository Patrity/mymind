import { deleteApproval } from '../../lib/exec/approvals'

export default defineEventHandler(async (event) => {
  // Allowlist authoring is a human-in-the-loop action; reject non-session clients (e.g. api-token).
  if (event.context.client?.type !== 'session') {
    throw createError({ statusCode: 403, statusMessage: 'Session required' })
  }
  const id = getQuery(event).id
  if (typeof id !== 'string' || !id) throw createError({ statusCode: 400, message: 'id required' })
  await deleteApproval(id)
  return { ok: true }
})
