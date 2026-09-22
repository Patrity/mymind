import { setActiveLeaf } from '../../../services/conversations'
import { publishChange } from '../../../utils/live-bus'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  // Both ids are validated here, not just leafId — a malformed one of either is a 400, not a
  // Postgres type error surfacing as a 500.
  if (!UUID.test(id)) throw createError({ statusCode: 400, statusMessage: 'id must be a uuid' })
  const body = await readBody(event) as { leafId?: unknown }
  const leafId = typeof body?.leafId === 'string' ? body.leafId : ''
  if (!UUID.test(leafId)) throw createError({ statusCode: 400, statusMessage: 'leafId must be a uuid' })

  // setActiveLeaf resolves to the CHOSEN message's deepest descendant, not `leafId` itself —
  // switching to a sibling that has its own continuation must not silently hide it. null means
  // leafId is not a message in this conversation.
  const resolved = await setActiveLeaf(id, leafId)
  if (!resolved) {
    throw createError({ statusCode: 404, statusMessage: 'That message is not in this conversation' })
  }

  publishChange({ resource: 'conversation', action: 'updated', id })
  // Return the RESOLVED leaf, never the requested one — the response must not claim a leaf it
  // did not actually set.
  return { ok: true, leafId: resolved }
})
