import { listSessions } from '../../services/sessions'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  return listSessions({
    ...(q.source ? { source: String(q.source) } : {}),
    ...(q.project ? { project: String(q.project) } : {})
  })
})
