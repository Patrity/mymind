// test/agent-runs-route.test.ts
//
// server/api/agent/runs.get.ts driven directly with a fake H3 event — same harness shape as
// sessions-messages-route.test.ts. Pins the input validation: a malformed `limit` degrades to
// the default rather than reaching Postgres as NaN; a malformed `conversationId` 400s before
// ever reaching listRuns (a raw uuid-column `eq()` would otherwise 500 on it).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('h3', async () => {
  const actual = await vi.importActual('h3')
  return {
    ...actual,
    getQuery: vi.fn((event) => {
      const url = new URL(event.node.req.url || '/?', 'http://localhost')
      const query: Record<string, string> = {}
      url.searchParams.forEach((value, key) => { query[key] = value })
      return query
    }),
    createError: vi.fn((opts) => {
      const error = new Error(opts.statusMessage)
      ;(error as never as { statusCode: number }).statusCode = opts.statusCode
      return error
    })
  }
})

globalThis.defineEventHandler = (fn: unknown) => fn as never
globalThis.createError = ((opts: { statusCode: number, statusMessage: string }) => {
  const error = new Error(opts.statusMessage)
  ;(error as never as { statusCode: number }).statusCode = opts.statusCode
  return error
}) as never
globalThis.getQuery = ((event: { node: { req: { url?: string } } }) => {
  const url = new URL(event.node.req.url || '/?', 'http://localhost')
  const query: Record<string, string> = {}
  url.searchParams.forEach((value, key) => { query[key] = value })
  return query
}) as never

const listRuns = vi.fn()
vi.mock('../server/lib/agent/runtime/runs', () => ({ listRuns }))

const handler = (await import('../server/api/agent/runs.get')).default

/** Minimal H3-ish event: the handler only reads the query string. */
function evt(query: Record<string, string>) {
  return { node: { req: { url: `/?${new URLSearchParams(query)}` } } } as never
}

const VALID_ID = '11111111-1111-1111-1111-111111111111'

beforeEach(() => { listRuns.mockReset() })

describe('GET /api/agent/runs', () => {
  it('defaults limit to 50 when absent', async () => {
    listRuns.mockResolvedValue([])
    await handler(evt({}))
    expect(listRuns).toHaveBeenCalledWith({ conversationId: undefined, limit: 50 })
  })

  it('falls back to 50 for a non-numeric limit instead of NaN', async () => {
    listRuns.mockResolvedValue([])
    await handler(evt({ limit: 'abc' }))
    expect(listRuns).toHaveBeenCalledWith({ conversationId: undefined, limit: 50 })
  })

  it('clamps an oversized limit down to 200', async () => {
    listRuns.mockResolvedValue([])
    await handler(evt({ limit: '999999' }))
    expect(listRuns).toHaveBeenCalledWith({ conversationId: undefined, limit: 200 })
  })

  it('clamps a limit below 1 up to 1 (zero, and negative)', async () => {
    listRuns.mockResolvedValue([])
    await handler(evt({ limit: '0' }))
    expect(listRuns).toHaveBeenCalledWith({ conversationId: undefined, limit: 1 })
    await handler(evt({ limit: '-5' }))
    expect(listRuns).toHaveBeenCalledWith({ conversationId: undefined, limit: 1 })
  })

  it('rejects a malformed conversationId with 400 instead of reaching the DB', async () => {
    await expect(handler(evt({ conversationId: 'not-a-uuid' }))).rejects.toMatchObject({ statusCode: 400 })
    expect(listRuns).not.toHaveBeenCalled()
  })

  it('accepts a well-formed conversationId', async () => {
    listRuns.mockResolvedValue([])
    await handler(evt({ conversationId: VALID_ID }))
    expect(listRuns).toHaveBeenCalledWith({ conversationId: VALID_ID, limit: 50 })
  })

  it('maps a run row to its DTO shape, including a computed duration', async () => {
    const claimed = new Date('2026-01-01T00:00:00.000Z')
    const finished = new Date('2026-01-01T00:00:02.500Z')
    listRuns.mockResolvedValue([{
      id: 'r1', trigger: 'wake', wakeReason: 'admin', profile: 'headless', status: 'done', suppressed: true,
      createdAt: claimed, finishedAt: finished, claimedAt: claimed, error: null, assistantMessageId: 'm1'
    }])
    const out = await handler(evt({}))
    expect(out).toEqual([{
      id: 'r1', trigger: 'wake', wakeReason: 'admin', profile: 'headless', status: 'done', suppressed: true,
      createdAt: claimed.toISOString(), finishedAt: finished.toISOString(), error: null,
      durationMs: 2500, assistantMessageId: 'm1'
    }])
  })

  it('durationMs is null when claimedAt or finishedAt is missing', async () => {
    listRuns.mockResolvedValue([{
      id: 'r2', trigger: 'user', wakeReason: null, profile: 'interactive', status: 'running', suppressed: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'), finishedAt: null, claimedAt: null, error: null, assistantMessageId: null
    }])
    const out = await handler(evt({}))
    expect((out as { durationMs: unknown }[])[0]!.durationMs).toBeNull()
  })
})
