import { addApproval, updateApproval, validatePattern } from '../../lib/exec/approvals'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ id?: string; pattern?: string; tool?: string }>(event)
  const pattern = (body.pattern ?? '').trim()
  const v = validatePattern(pattern)
  if (!v.valid) throw createError({ statusCode: 400, message: v.error ?? 'invalid pattern' })
  const row = body.id
    ? await updateApproval(body.id, pattern)
    : await addApproval({ pattern, tool: body.tool })
  if (!row) throw createError({ statusCode: 404, message: 'approval not found' })
  return { id: row.id, pattern: row.pattern, tool: row.tool, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt }
})
