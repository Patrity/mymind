import { deleteApproval } from '../../lib/exec/approvals'

export default defineEventHandler(async (event) => {
  const id = getQuery(event).id
  if (typeof id !== 'string' || !id) throw createError({ statusCode: 400, message: 'id required' })
  await deleteApproval(id)
  return { ok: true }
})
