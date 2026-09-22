import { describe, it, expect, vi, beforeEach } from 'vitest'

const setActiveLeaf = vi.fn()
vi.mock('../server/services/conversations', () => ({ setActiveLeaf }))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('getRouterParam', (e: { ctx: Record<string, string> }, k: string) => e.ctx[k])
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)

// publishChange is NOT mocked: it's a synchronous in-process EventEmitter.emit with no
// listeners registered in this test (server/utils/live-bus.ts) — safe to run for real.
const handler = (await import('../server/api/conversations/[id]/leaf.patch')).default as (e: unknown) => Promise<unknown>
const CONV_ID = '6f1e7b4a-0000-4000-8000-0000000000c1'
const evt = (body: unknown, convId: string = CONV_ID) => ({ ctx: { id: convId }, body })

beforeEach(() => setActiveLeaf.mockReset())

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
