import { describe, it, expect, vi, beforeEach } from 'vitest'

const setActiveLeaf = vi.fn()
const setBranchLeaf = vi.fn()
const cancelPendingRoot = vi.fn()
const restoreAfterUnsentBranch = vi.fn()
vi.mock('@mymind/core/services/conversations', () => ({ setActiveLeaf, setBranchLeaf, cancelPendingRoot, restoreAfterUnsentBranch, NEW_ROOT: 'new-root' }))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('getRouterParam', (e: { ctx: Record<string, string> }, k: string) => e.ctx[k])
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)

// publishChange is NOT mocked: it's a synchronous in-process EventEmitter.emit with no
// listeners registered in this test (server/utils/live-bus.ts) — safe to run for real.
const handler = (await import('../server/api/conversations/[id]/leaf.patch')).default as (e: unknown) => Promise<unknown>
const CONV_ID = '6f1e7b4a-0000-4000-8000-0000000000c1'
const evt = (body: unknown, convId: string = CONV_ID) => ({ ctx: { id: convId }, body })
const MSG_ID = '6f1e7b4a-0000-4000-8000-000000000001'

beforeEach(() => { setActiveLeaf.mockReset(); setBranchLeaf.mockReset(); cancelPendingRoot.mockReset(); restoreAfterUnsentBranch.mockReset() })

describe('PATCH /api/conversations/:id/leaf', () => {
  it('moves the leaf to the RESOLVED descendant, not necessarily the requested id', async () => {
    // setActiveLeaf resolves the chosen sibling's deepest descendant — the route must echo
    // back what was actually set, not what the client asked for.
    setActiveLeaf.mockResolvedValue('6f1e7b4a-0000-4000-8000-000000000099')
    const out = await handler(evt({ leafId: '6f1e7b4a-0000-4000-8000-000000000001' }))
    expect(setActiveLeaf).toHaveBeenCalledWith(CONV_ID, '6f1e7b4a-0000-4000-8000-000000000001')
    expect(out).toEqual({ ok: true, leafId: '6f1e7b4a-0000-4000-8000-000000000099' })
  })

  it('rejects a missing leafId', async () => {
    await expect(handler(evt({}))).rejects.toMatchObject({ statusCode: 400 })
    expect(setActiveLeaf).not.toHaveBeenCalled()
  })

  it('rejects a non-uuid leafId rather than letting Postgres throw', async () => {
    await expect(handler(evt({ leafId: 'not-a-uuid' }))).rejects.toMatchObject({ statusCode: 400 })
    expect(setActiveLeaf).not.toHaveBeenCalled()
  })

  // The conversation id is as user-supplied (part of the URL) as leafId is, and gets the same
  // guard — a malformed one must not reach the DB either.
  it('rejects a non-uuid conversation id rather than letting Postgres throw', async () => {
    await expect(handler(evt({ leafId: '6f1e7b4a-0000-4000-8000-000000000001' }, 'not-a-uuid')))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(setActiveLeaf).not.toHaveBeenCalled()
  })

  it('404s when the message does not belong to the conversation', async () => {
    setActiveLeaf.mockResolvedValue(null)
    await expect(handler(evt({ leafId: '6f1e7b4a-0000-4000-8000-000000000002' })))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})

// An `op` switches the route from "resume that branch" (descend to its tip) to "start a new
// branch here" (set branchParent's answer exactly). Routing the two to the same resolver is the
// defect these cover: setActiveLeaf descends, so a fork routed through it lands back on the tip
// of the branch being forked — i.e. no fork at all.
describe('PATCH /api/conversations/:id/leaf — branch ops', () => {
  it.each(['fork', 'edit', 'regenerate'] as const)('routes op=%s to setBranchLeaf, NOT the descending setActiveLeaf', async (op) => {
    setBranchLeaf.mockResolvedValue('6f1e7b4a-0000-4000-8000-0000000000aa')
    const out = await handler(evt({ leafId: MSG_ID, op }))
    expect(setBranchLeaf).toHaveBeenCalledWith(CONV_ID, MSG_ID, op)
    expect(setActiveLeaf).not.toHaveBeenCalled()
    expect(out).toEqual({ ok: true, leafId: '6f1e7b4a-0000-4000-8000-0000000000aa' })
  })

  it('still descends when no op is given — Task 5 behaviour is untouched', async () => {
    setActiveLeaf.mockResolvedValue('6f1e7b4a-0000-4000-8000-000000000099')
    await handler(evt({ leafId: MSG_ID }))
    expect(setActiveLeaf).toHaveBeenCalledWith(CONV_ID, MSG_ID)
    expect(setBranchLeaf).not.toHaveBeenCalled()
  })

  it('404s "not in this conversation" when the op resolves to null (a foreign id)', async () => {
    setBranchLeaf.mockResolvedValue(null)
    await expect(handler(evt({ leafId: MSG_ID, op: 'edit' }))).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: 'That message is not in this conversation'
    })
  })

  // Cycle 88: an edit/regenerate of the FIRST message is a real branch now, not a 404. There is
  // no leaf to report yet (the new root is written by the next turn), so the response says null
  // rather than echoing the sentinel or claiming the requested id.
  it.each(['edit', 'regenerate'] as const)('answers 200 with leafId null when op=%s targets a root (NEW_ROOT)', async (op) => {
    setBranchLeaf.mockResolvedValue('new-root')
    const out = await handler(evt({ leafId: MSG_ID, op }))
    expect(out).toEqual({ ok: true, leafId: null })
  })

  it('still 404s on the no-op path for an unknown id', async () => {
    setActiveLeaf.mockResolvedValue(null)
    await expect(handler(evt({ leafId: MSG_ID }))).rejects.toMatchObject({
      statusMessage: 'That message is not in this conversation'
    })
  })

  // A bad op must not degrade to the no-op path: that would silently turn a typo'd fork into
  // "carry on as normal", which is the very thing the op was added to stop.
  it('rejects an unknown op rather than falling back to descending', async () => {
    await expect(handler(evt({ leafId: MSG_ID, op: 'branch' }))).rejects.toMatchObject({ statusCode: 400 })
    expect(setActiveLeaf).not.toHaveBeenCalled()
    expect(setBranchLeaf).not.toHaveBeenCalled()
  })

  it('rejects a non-string op', async () => {
    await expect(handler(evt({ leafId: MSG_ID, op: 7 }))).rejects.toMatchObject({ statusCode: 400 })
    expect(setBranchLeaf).not.toHaveBeenCalled()
  })

  // An explicit null is how a JSON body says "no op" — it must read as absent, not as invalid.
  it('treats a null op as absent', async () => {
    setActiveLeaf.mockResolvedValue(MSG_ID)
    await handler(evt({ leafId: MSG_ID, op: null }))
    expect(setActiveLeaf).toHaveBeenCalledWith(CONV_ID, MSG_ID)
  })
})

// Review I4: the client restores a branch move whose turn never went out WITHOUT naming a leaf
// (its transcript tail was a live stream). A pending first-message edit is cancelled exactly;
// anything else descends from the branch parent.
describe('PATCH /api/conversations/:id/leaf — op restore', () => {
  it('cancels a pending first-message edit exactly, touching no leaf', async () => {
    cancelPendingRoot.mockResolvedValue(true)
    expect(await handler(evt({ op: 'restore' }))).toEqual({ ok: true, restored: 'exact' })
    expect(cancelPendingRoot).toHaveBeenCalledWith(CONV_ID)
    expect(restoreAfterUnsentBranch).not.toHaveBeenCalled()
    expect(setActiveLeaf).not.toHaveBeenCalled()
  })
  it('otherwise descends to the newest branch tip', async () => {
    cancelPendingRoot.mockResolvedValue(false)
    restoreAfterUnsentBranch.mockResolvedValue('newest-branch')
    expect(await handler(evt({ op: 'restore' }))).toEqual({ ok: true, restored: 'newest-branch' })
    expect(restoreAfterUnsentBranch).toHaveBeenCalledWith(CONV_ID)
  })
  it('404s when there is nothing to restore', async () => {
    cancelPendingRoot.mockResolvedValue(false)
    restoreAfterUnsentBranch.mockResolvedValue(null)
    await expect(handler(evt({ op: 'restore' }))).rejects.toMatchObject({ statusCode: 404 })
  })
  it('rejects a leafId with op restore', async () => {
    await expect(handler(evt({ op: 'restore', leafId: MSG_ID }))).rejects.toMatchObject({ statusCode: 400 })
    expect(cancelPendingRoot).not.toHaveBeenCalled()
  })
})

