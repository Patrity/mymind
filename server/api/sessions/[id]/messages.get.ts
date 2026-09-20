import { getSessionMessages, getSessionMessagesPage } from '../../../services/sessions'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const q = getQuery(event)
  const since = q.since as string | undefined
  const sinceId = q.sinceId as string | undefined
  const before = q.before as string | undefined

  // Two different pagination modes. Honouring one and ignoring the other silently would
  // hand the client a page it did not ask for.
  if (since && before) {
    throw createError({ statusCode: 400, statusMessage: 'Pass either `since` or `before`, not both' })
  }

  // `sinceId` is the id of the client's newest held row: the delta compares (created_at, id)
  // against it, so rows sharing the boundary timestamp are not skipped. It is spliced into a
  // ::uuid cast, so a malformed one is a 400 here rather than a 500 out of Postgres.
  if (sinceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sinceId)) {
    throw createError({ statusCode: 400, statusMessage: 'Malformed `sinceId`' })
  }

  // The live-tail delta carries the ACTIVE filters too — filtering it client-side would let a
  // row the filter excludes appear in a list the filter has narrowed. Absent params are left
  // off entirely so an unfiltered delta is still a plain `{ since }` read.
  if (since) {
    return getSessionMessages(id, {
      since,
      ...(sinceId ? { sinceId } : {}),
      ...(q.hideSidechain === 'true' ? { hideSidechain: true } : {}),
      ...(q.tool ? { tool: q.tool as string } : {}),
      ...(q.q ? { q: q.q as string } : {})
    })
  }

  const rawLimit = Number(q.limit)
  return getSessionMessagesPage(id, {
    before,
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
    hideSidechain: q.hideSidechain === 'true',
    tool: (q.tool as string) || undefined,
    q: (q.q as string) || undefined
  })
})
