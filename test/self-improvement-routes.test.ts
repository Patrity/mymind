// test/self-improvement-routes.test.ts
//
// Handler tests (store mocked) for GET/PUT /api/settings/self-improvement (cycle 76, Task 3).
// The mode is one global settings row on the shared dev DB, so the store module is mocked here
// (its own fallback logic has a DB test from Task 1). requireSession is NOT mocked, so the routes
// are proven to be wired to it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body?: unknown }) => e.body)

let stored: 'on' | 'review_only' | 'off' = 'on'
const getSelfImprovementMode = vi.fn(async () => stored)
const setSelfImprovementMode = vi.fn(async (m: typeof stored) => { stored = m })
vi.mock('../server/lib/agent/self-improvement-mode', () => ({ getSelfImprovementMode, setSelfImprovementMode }))

type H = (e: unknown) => Promise<unknown>
const get = (await import('../server/api/settings/self-improvement.get')).default as H
const put = (await import('../server/api/settings/self-improvement.put')).default as H

const evt = (client: { type?: string } | undefined, body: unknown = {}) => ({ context: { client }, body })
const session = { type: 'session', userId: 'u1' }

beforeEach(() => {
  stored = 'on'
  getSelfImprovementMode.mockClear()
  setSelfImprovementMode.mockClear()
})

describe.each([
  ['GET /api/settings/self-improvement', () => get, {}],
  ['PUT /api/settings/self-improvement', () => put, { mode: 'off' }]
] as const)('%s requires a web session', (_name, getHandler, body) => {
  it('403s a bearer-token-only (api-token) client', async () => {
    await expect(getHandler()(evt({ type: 'api-token', tokenId: 't1' }, body))).rejects.toMatchObject({ statusCode: 403 })
    expect(setSelfImprovementMode).not.toHaveBeenCalled()
  })
  it('403s a request with no client context at all', async () => {
    await expect(getHandler()(evt(undefined, body))).rejects.toMatchObject({ statusCode: 403 })
    expect(setSelfImprovementMode).not.toHaveBeenCalled()
  })
})

describe('self-improvement mode routes', () => {
  it('GET returns the stored mode', async () => {
    stored = 'review_only'
    await expect(get(evt(session))).resolves.toEqual({ mode: 'review_only' })
  })

  it.each(['on', 'review_only', 'off'] as const)('PUT accepts %s, stores it and returns it', async (mode) => {
    await expect(put(evt(session, { mode }))).resolves.toEqual({ mode })
    expect(setSelfImprovementMode).toHaveBeenCalledWith(mode)
  })

  it.each([
    ['an unknown value', { mode: 'sometimes' }],
    ['an empty string', { mode: '' }],
    ['a missing mode', {}],
    ['a non-string', { mode: 1 }]
  ])('PUT 400s %s, writing nothing', async (_label, body) => {
    await expect(put(evt(session, body))).rejects.toMatchObject({ statusCode: 400 })
    expect(setSelfImprovementMode).not.toHaveBeenCalled()
  })
})
