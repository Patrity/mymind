import { setActiveLeaf, setBranchLeaf } from '../../../services/conversations'
import { publishChange } from '../../../utils/live-bus'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPS = ['fork', 'edit', 'regenerate'] as const
type BranchOp = typeof OPS[number]

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  // Both ids are validated here, not just leafId — a malformed one of either is a 400, not a
  // Postgres type error surfacing as a 500.
  if (!UUID.test(id)) throw createError({ statusCode: 400, statusMessage: 'id must be a uuid' })
  const body = await readBody(event) as { leafId?: unknown, op?: unknown }
  const leafId = typeof body?.leafId === 'string' ? body.leafId : ''
  if (!UUID.test(leafId)) throw createError({ statusCode: 400, statusMessage: 'leafId must be a uuid' })
  // `op` is optional, but an op the server doesn't know is a client bug, not "no op" — silently
  // falling back to the descending path would turn a typo'd fork into "carry on as normal",
  // which is exactly the failure the op exists to prevent.
  const op = body?.op === undefined || body?.op === null ? undefined : body.op
  if (op !== undefined && !(typeof op === 'string' && (OPS as readonly string[]).includes(op))) {
    throw createError({ statusCode: 400, statusMessage: `op must be one of ${OPS.join(', ')}` })
  }

  // Two different questions, two different resolvers:
  //
  // No op — "switch to this branch". setActiveLeaf resolves to the CHOSEN message's branch tip,
  // not `leafId` itself: switching to a sibling that has its own continuation must not silently
  // hide it.
  //
  // With an op — "start a new branch here". The tree decision is branchParent's (fork → the
  // message; edit/regenerate → its parent) and the result is written EXACTLY, because the
  // descent above would walk a fork straight back to the end of the thread and undo it.
  //
  // null from either means there is nothing to point at: not a message in this conversation,
  // or (with an op) a root whose parent a leaf column cannot express.
  const resolved = op
    ? await setBranchLeaf(id, leafId, op as BranchOp)
    : await setActiveLeaf(id, leafId)
  if (!resolved) {
    throw createError({ statusCode: 404, statusMessage: 'That message is not in this conversation' })
  }

  publishChange({ resource: 'conversation', action: 'updated', id })
  // Return the RESOLVED leaf, never the requested one — the response must not claim a leaf it
  // did not actually set.
  return { ok: true, leafId: resolved }
})
