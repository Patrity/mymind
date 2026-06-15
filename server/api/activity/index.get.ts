import { listActivity } from '../../services/activity'
import type { ActivityListParams } from '../../../shared/types/activity'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const p: ActivityListParams = {
    kind: q.kind as ActivityListParams['kind'],
    status: q.status as ActivityListParams['status'],
    severity: q.severity as ActivityListParams['severity'],
    usage: q.usage ? String(q.usage) : undefined,
    traceId: q.traceId ? String(q.traceId) : undefined,
    q: q.q ? String(q.q) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    before: q.before ? String(q.before) : undefined
  }
  return listActivity(p)
})
