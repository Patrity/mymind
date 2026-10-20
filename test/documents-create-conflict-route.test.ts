// POST /api/documents: a duplicate live path (unique index documents_path_live_uidx) is a 409, not a 500.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string, message?: string }) =>
  Object.assign(new Error(o.message ?? o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)

const createDoc = vi.fn()
vi.mock('@mymind/core/services/documents', () => ({ createDoc }))
vi.mock('@mymind/core/utils/live-bus', () => ({ publishChange: vi.fn() }))

const handler = (await import('../server/api/documents/index.post')).default as (e: unknown) => Promise<unknown>
const evt = (body: unknown) => ({ body })

beforeEach(() => createDoc.mockReset())

describe('POST /api/documents', () => {
  it('maps documents_path_live_uidx (direct and drizzle-wrapped) to 409 naming the path', async () => {
    createDoc.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint: 'documents_path_live_uidx' }))
    await expect(handler(evt({ path: '/a/b.md' }))).rejects.toMatchObject({
      statusCode: 409, message: expect.stringMatching(/\/a\/b\.md/)
    })
    createDoc.mockRejectedValueOnce(Object.assign(new Error('Failed query'), { cause: { code: '23505', constraint: 'documents_path_live_uidx' } }))
    await expect(handler(evt({ path: '/a/b.md' }))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('does not swallow other errors (other unique index, generic) as 409', async () => {
    const other = Object.assign(new Error('other'), { code: '23505', constraint: 'something_else' })
    createDoc.mockRejectedValueOnce(other)
    await expect(handler(evt({ path: '/a.md' }))).rejects.toBe(other)
    const boom = new Error('boom')
    createDoc.mockRejectedValueOnce(boom)
    await expect(handler(evt({ path: '/a.md' }))).rejects.toBe(boom)
  })

  it('returns the created doc on success', async () => {
    createDoc.mockResolvedValueOnce({ id: 'd1', path: '/ok.md' })
    expect(await handler(evt({ path: '/ok.md' }))).toEqual({ id: 'd1', path: '/ok.md' })
  })
})
