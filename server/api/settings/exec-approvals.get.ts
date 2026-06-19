import { loadApprovals } from '../../lib/exec/approvals'

export default defineEventHandler(async () => {
  const rows = await loadApprovals()
  return rows.map(r => ({ id: r.id, pattern: r.pattern, tool: r.tool, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }))
})
