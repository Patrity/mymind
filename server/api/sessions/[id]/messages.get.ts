import { getSessionMessages, getSessionMessagesPage } from '../../../services/sessions'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const q = getQuery(event)
  const since = q.since as string | undefined
  const before = q.before as string | undefined

  // Two different pagination modes. Honouring one and ignoring the other silently would
  // hand the client a page it did not ask for.
  if (since && before) {
    throw createError({ statusCode: 400, statusMessage: 'Pass either `since` or `before`, not both' })
  }

  if (since) return getSessionMessages(id, { since })

  const rawLimit = Number(q.limit)
  return getSessionMessagesPage(id, {
    before,
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
    hideSidechain: q.hideSidechain === 'true',
    tool: (q.tool as string) || undefined,
    q: (q.q as string) || undefined
  })
})
