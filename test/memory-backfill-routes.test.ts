// test/memory-backfill-routes.test.ts
//
// Handler tests (service mocked) for GET/PUT /api/memories/backfill (cycle 77, Task 5). The
// switch is one global settings row on the shared dev DB, so the service is mocked here (the
// service has its own DB test). requireSession is NOT mocked, so the routes are proven wired to it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body?: unknown }) => e.body)

const PROGRESS = {
  state: 'running', total: 10, jevDone: 4, auditDone: 5, skipped: 1, remaining: 5,
  startedAt: '2026-10-01T00:00:00.000Z', etaMinutes: 12, lastError: null
}
const backfillProgress = vi.fn(async () => PROGRESS)
const setBackfillSwitch = vi.fn(async (state: string) => ({ state, startedAt: null, finishedAt: null }))
vi.mock('../server/services/memory-backfill', () => ({ backfillProgress, setBackfillSwitch }))

type H = (e: unknown) => Promise<unknown>
const get = (await import('../server/api/memories/backfill.get')).default as H
const put = (await import('../server/api/memories/backfill.put')).default as H

const evt = (client: { type?: string } | undefined, body: unknown = {}) => ({ context: { client }, body })
const session = { type: 'session', userId: 'u1' }

beforeEach(() => {
  backfillProgress.mockClear()
  setBackfillSwitch.mockClear()
})

describe.each([
  ['GET /api/memories/backfill', () => get, {}],
  ['PUT /api/memories/backfill', () => put, { state: 'running' }]
] as const)('%s requires a web session', (_name, getHandler, body) => {
  it('403s a bearer-token-only (api-token) client', async () => {
    await expect(getHandler()(evt({ type: 'api-token', tokenId: 't1' }, body))).rejects.toMatchObject({ statusCode: 403 })
    expect(setBackfillSwitch).not.toHaveBeenCalled()
    expect(backfillProgress).not.toHaveBeenCalled()
  })
  it('403s an oauth (MCP) client', async () => {
    await expect(getHandler()(evt({ type: 'oauth' }, body))).rejects.toMatchObject({ statusCode: 403 })
    expect(setBackfillSwitch).not.toHaveBeenCalled()
  })
  it('403s a request with no client context at all', async () => {
    await expect(getHandler()(evt(undefined, body))).rejects.toMatchObject({ statusCode: 403 })
    expect(setBackfillSwitch).not.toHaveBeenCalled()
  })
})

describe('memory backfill routes', () => {
  it('GET returns the progress', async () => {
    await expect(get(evt(session))).resolves.toEqual(PROGRESS)
  })

  it.each(['running', 'off'] as const)('PUT accepts %s, flips the switch and returns progress', async (state) => {
    await expect(put(evt(session, { state }))).resolves.toEqual(PROGRESS)
    expect(setBackfillSwitch).toHaveBeenCalledWith(state)
  })

  it.each([
    ['done (only the backfill itself finishes a run)', { state: 'done' }],
    ['an unknown value', { state: 'paused' }],
    ['an empty string', { state: '' }],
    ['a missing state', {}],
    ['a non-string', { state: 1 }]
  ])('PUT 400s %s, writing nothing', async (_label, body) => {
    await expect(put(evt(session, body))).rejects.toMatchObject({ statusCode: 400 })
    expect(setBackfillSwitch).not.toHaveBeenCalled()
  })
})
