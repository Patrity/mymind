// test/profile-routes.test.ts
//
// Handler tests (service mocked) for the "About Tony" profile HTTP API (cycle 76, Task 2) —
// same stubGlobal + dynamic-import harness as test/jobs-routes.test.ts. server/services/profile.ts
// is mocked (its own CAS/revision logic is covered by test/profile.db.test.ts against a real DB);
// requireSession itself is NOT mocked (server/utils/auth-guard.ts, pure predicate over
// event.context.client) so these routes are proven to actually be wired to it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string, data?: unknown }) =>
  Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body?: unknown }) => e.body)

const getProfileSource = vi.fn()
const saveProfileSource = vi.fn()
const listProfileRevisions = vi.fn()
const revertProfile = vi.fn()
vi.mock('../server/services/profile', () => ({ getProfileSource, saveProfileSource, listProfileRevisions, revertProfile }))

// The real ConflictError — server/utils/agent-config-http.ts's throwAgentConfigWriteError
// checks `instanceof ConflictError` against this exact class, and saveProfileSource/revertProfile
// throw it for real, so the mock above must not shadow it.
const { ConflictError } = await import('../server/services/skills')

type H = (e: unknown) => Promise<unknown>
const sourceGet = (await import('../server/api/profile/source.get')).default as H
const sourcePut = (await import('../server/api/profile/source.put')).default as H
const revisionsGet = (await import('../server/api/profile/revisions.get')).default as H
const revertPost = (await import('../server/api/profile/revert.post')).default as H

const evt = (client: { type?: string } | undefined, body: unknown = {}) => ({ context: { client }, body })
const session = { type: 'session', userId: 'u1' }

const SOURCE = { content: 'Likes terse answers.', contentHash: 'h1', updatedBy: 'human', updatedAt: '2026-01-01T00:00:00.000Z' }

beforeEach(() => {
  getProfileSource.mockReset(); saveProfileSource.mockReset()
  listProfileRevisions.mockReset(); revertProfile.mockReset()
})

describe.each([
  ['GET /api/profile/source', () => sourceGet, {}],
  ['PUT /api/profile/source', () => sourcePut, { content: 'x', expectedHash: 'h1' }],
  ['GET /api/profile/revisions', () => revisionsGet, {}],
  ['POST /api/profile/revert', () => revertPost, { revisionId: 'rev1' }]
] as const)('%s requires a web session', (_name, getHandler, body) => {
  it('403s a bearer-token-only (api-token) client', async () => {
    await expect(getHandler()(evt({ type: 'api-token', tokenId: 't1' }, body))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('403s a request with no client context at all', async () => {
    await expect(getHandler()(evt(undefined, body))).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('GET /api/profile/source', () => {
  it('returns the profile plus tokens/budget/overBudget for a short profile', async () => {
    getProfileSource.mockResolvedValue(SOURCE)
    const out = await sourceGet(evt(session)) as typeof SOURCE & { tokens: number, budget: number, overBudget: boolean }
    expect(out).toMatchObject(SOURCE)
    expect(out.tokens).toBe(Math.ceil(SOURCE.content.length / 4))
    expect(out.budget).toBe(1500)
    expect(out.overBudget).toBe(false)
  })

  it('overBudget is true once the content exceeds the 1,500-token budget', async () => {
    getProfileSource.mockResolvedValue({ ...SOURCE, content: 'x'.repeat(1500 * 4 + 1) })
    const out = await sourceGet(evt(session)) as { overBudget: boolean }
    expect(out.overBudget).toBe(true)
  })
})

describe('PUT /api/profile/source', () => {
  it('saves with CAS and returns the ProfileSource', async () => {
    saveProfileSource.mockResolvedValue(SOURCE)
    const out = await sourcePut(evt(session, { content: 'x', expectedHash: 'h0' }))
    expect(saveProfileSource).toHaveBeenCalledWith('x', 'h0', 'human')
    expect(out).toEqual(SOURCE)
  })

  it('409s and carries current on a CAS mismatch', async () => {
    saveProfileSource.mockRejectedValue(new ConflictError({ content: 'their content', contentHash: 'theirhash' }))
    await expect(sourcePut(evt(session, { content: 'x', expectedHash: 'stale' })))
      .rejects.toMatchObject({ statusCode: 409, data: { current: { content: 'their content', contentHash: 'theirhash' } } })
  })

  it('400s on a malformed body before ever calling saveProfileSource', async () => {
    await expect(sourcePut(evt(session, { content: 'x' }))).rejects.toMatchObject({ statusCode: 400 })
    expect(saveProfileSource).not.toHaveBeenCalled()
  })
})

describe('GET /api/profile/revisions', () => {
  it('returns the revision list', async () => {
    const revs = [{ id: 'rev1', content: 'x', actor: 'human', createdAt: new Date('2026-01-01T00:00:00.000Z'), improvementId: null }]
    listProfileRevisions.mockResolvedValue(revs)
    await expect(revisionsGet(evt(session))).resolves.toEqual(revs)
  })
})

describe('POST /api/profile/revert', () => {
  it('reverts and returns the ProfileSource', async () => {
    revertProfile.mockResolvedValue(SOURCE)
    const out = await revertPost(evt(session, { revisionId: 'rev1' }))
    expect(revertProfile).toHaveBeenCalledWith('rev1', 'human')
    expect(out).toEqual(SOURCE)
  })

  it('409s and carries current when the profile changed since it was read', async () => {
    revertProfile.mockRejectedValue(new ConflictError({ content: 'their content', contentHash: 'theirhash' }))
    await expect(revertPost(evt(session, { revisionId: 'rev1' })))
      .rejects.toMatchObject({ statusCode: 409, data: { current: { content: 'their content', contentHash: 'theirhash' } } })
  })

  it('400s on a bad revision id (a plain Error from the service, not a class)', async () => {
    revertProfile.mockRejectedValue(new Error('revision rev9 does not belong to the profile'))
    await expect(revertPost(evt(session, { revisionId: 'rev9' })))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'revision rev9 does not belong to the profile' })
  })

  it('400s on a malformed body before ever calling revertProfile', async () => {
    await expect(revertPost(evt(session, {}))).rejects.toMatchObject({ statusCode: 400 })
    expect(revertProfile).not.toHaveBeenCalled()
  })
})
