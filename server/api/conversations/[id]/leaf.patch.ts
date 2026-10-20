import { cancelPendingRoot, restoreAfterUnsentBranch, setActiveLeaf, setBranchLeaf, NEW_ROOT } from '@mymind/core/services/conversations'
import { publishChange } from '@mymind/core/utils/live-bus'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPS = ['fork', 'edit', 'regenerate'] as const
type BranchOp = typeof OPS[number]

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  // Both ids are validated here, not just leafId — a malformed one of either is a 400, not a
  // Postgres type error surfacing as a 500.
  if (!UUID.test(id)) throw createError({ statusCode: 400, statusMessage: 'id must be a uuid' })
  const body = await readBody(event) as { leafId?: unknown, op?: unknown }

  // op 'restore' with no leafId: "the branch I just made never got its turn — put the thread
  // back" when the client cannot name the old leaf (its transcript tail was still a live stream).
  // A pending FIRST-message edit is undone exactly (cancelPendingRoot: the leaf never moved); any
  // other branch move descends from the current leaf to its newest tip, so nothing stays hidden.
  if (body?.op === 'restore') {
    if (body.leafId !== undefined && body.leafId !== null) throw createError({ statusCode: 400, statusMessage: 'op restore takes no leafId' })
    const restored = await cancelPendingRoot(id) ? 'exact' as const : await restoreAfterUnsentBranch(id)
    if (!restored) throw createError({ statusCode: 404, statusMessage: 'Nothing to restore in this conversation' })
    publishChange({ resource: 'conversation', action: 'updated', id })
    return { ok: true, restored }
  }

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
  // null from either means the message is not in this conversation. An edit/regenerate of the
  // FIRST message answers NEW_ROOT (cycle 88): the thread's path is now empty and the next turn
  // starts a second root, a sibling of the original first message.
  const resolved = op
    ? await setBranchLeaf(id, leafId, op as BranchOp)
    : await setActiveLeaf(id, leafId)
  if (!resolved) throw createError({ statusCode: 404, statusMessage: 'That message is not in this conversation' })

  publishChange({ resource: 'conversation', action: 'updated', id })
  // Return the RESOLVED leaf, never the requested one — the response must not claim a leaf it
  // did not actually set. A new-root branch has no leaf yet: null.
  return { ok: true, leafId: resolved === NEW_ROOT ? null : resolved }
})
