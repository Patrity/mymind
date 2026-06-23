import { listMessages } from '../../../../services/clipboard'

export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, 'id')!
  const q = getQuery(event)
  return listMessages({
    threadId,
    since: q.since ? String(q.since) : undefined,
    before: q.before ? String(q.before) : undefined,
    limit: q.limit ? Number(q.limit) : undefined
  })
})
