// Cycle 81 Task 6: the /api/workstreams routes' error mapping and the control round trip — a refusal
// reaches the UI as a 409 with readable text, a silent worker as a 504 (never a quiet OK), and
// controls go through the `workstream-control` command (the worker holds the segment).
// Cycle 83: the top-level cap of 3 is gone — no route maps anything to `cap` any more.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number; statusMessage?: string; data?: unknown }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)
vi.stubGlobal('getQuery', (e: { query?: Record<string, string> }) => e.query ?? {})
vi.stubGlobal('getRouterParam', (e: { params?: Record<string, string> }, k: string) => e.params?.[k])

const sendCommand = vi.fn()
vi.mock('@mymind/core/lib/bus/commands', async (orig) => ({ ...(await orig<typeof import('@mymind/core/lib/bus/commands')>()), sendCommand: (...a: unknown[]) => sendCommand(...a) }))
const startWorkstream = vi.fn()
vi.mock('@mymind/core/lib/agent/workstreams/loop', async (orig) => ({ ...(await orig<typeof import('@mymind/core/lib/agent/workstreams/loop')>()), startWorkstream: (...a: unknown[]) => startWorkstream(...a) }))

const listWorkstreams = vi.fn(async (_o: unknown) => [])
const childrenOf = vi.fn(async (_id: string, _p?: unknown) => [])
vi.mock('@mymind/core/lib/agent/workstreams/store', async (orig) => ({ ...(await orig<typeof import('@mymind/core/lib/agent/workstreams/store')>()), listWorkstreams: (o: unknown) => listWorkstreams(o), childrenOf: (id: string, p?: unknown) => childrenOf(id, p) }))

const { CommandFailedError, CommandTimeoutError } = await import('@mymind/core/lib/bus/commands')
const loopModule = await import('@mymind/core/lib/agent/workstreams/loop')
const { workstreamError } = await import('../server/utils/workstreams-http')
type H = (e: unknown) => Promise<unknown>
const cancel = (await import('../server/api/workstreams/[id]/cancel.post')).default as H
const resume = (await import('../server/api/workstreams/[id]/resume.post')).default as H
const steer = (await import('../server/api/workstreams/[id]/steer.post')).default as H
const start = (await import('../server/api/workstreams/index.post')).default as H
const list = (await import('../server/api/workstreams/index.get')).default as H
const childrenRoute = (await import('../server/api/workstreams/[id]/children.get')).default as H

const SESSION = { client: { type: 'session' } }
const TOKEN = { client: { type: 'api-token', tokenId: 't1' } }
const ID = '0b6f3c1e-5d2a-4f7b-9c8e-1a2b3c4d5e6f'
type HttpErr = Error & { statusCode: number; data: { code: string; message: string } }

beforeEach(() => { sendCommand.mockReset(); startWorkstream.mockReset() })

describe('workstreamError', () => {
  it('cycle 83: the cap is gone — no WorkstreamCapError, and old cap words are an ordinary refusal', () => {
    expect('WorkstreamCapError' in loopModule).toBe(false)
    expect('MAX_ACTIVE_WORKSTREAMS' in loopModule).toBe(false)
    const old = 'There are already 3 workstreams in progress (the limit is 3) — finish or cancel one before resuming this one.'
    expect((workstreamError(new CommandFailedError('workstream-control', 2, old)) as HttpErr).data).toEqual({ code: 'refused', message: old })
  })
  it('a worker that does not answer is a 504 that says nothing was done (or that it may still happen)', () => {
    const unclaimed = workstreamError(new CommandTimeoutError('workstream-control', 1, 10_000, false)) as HttpErr
    expect(unclaimed.statusCode).toBe(504)
    expect(unclaimed.data.message).toMatch(/nothing was done/)
    expect((workstreamError(new CommandTimeoutError('workstream-control', 1, 10_000, true)) as HttpErr).data.message).toMatch(/may still happen/)
  })
  it('other refusals keep the worker\'s words; an unknown id is a 404', () => {
    expect((workstreamError(new CommandFailedError('workstream-control', 1, 'the workstream is already done')) as HttpErr)).toMatchObject({ statusCode: 409, data: { code: 'refused', message: 'the workstream is already done' } })
    expect((workstreamError(new CommandFailedError('workstream-control', 1, 'no such workstream')) as HttpErr).statusCode).toBe(404)
  })
})

describe('auth (final review I5: the wake.post precedent)', () => {
  it('start and resume need a web session — a leaked API token cannot launch an unattended run', async () => {
    sendCommand.mockResolvedValue({ id: ID, state: 'running' })
    await expect(start({ context: TOKEN, body: { goal: 'list my tasks' } })).rejects.toMatchObject({ statusCode: 403 })
    await expect(resume({ params: { id: ID }, context: TOKEN })).rejects.toMatchObject({ statusCode: 403 })
    await expect(resume({ params: { id: ID }, context: {} })).rejects.toMatchObject({ statusCode: 403 })
    expect(startWorkstream).not.toHaveBeenCalled()
    expect(sendCommand).not.toHaveBeenCalled()
  })
  it('re-review NEW-1: steer needs a session too (it can answer or continue paused work) — a token is 403, a session works', async () => {
    sendCommand.mockResolvedValue({ id: ID, state: 'running' })
    await expect(steer({ params: { id: ID }, context: TOKEN, body: { text: 'carry on' } })).rejects.toMatchObject({ statusCode: 403 })
    expect(sendCommand).not.toHaveBeenCalled()
    await steer({ params: { id: ID }, context: SESSION, body: { text: 'carry on' } })
    expect(sendCommand).toHaveBeenLastCalledWith('workstream-control', { workstreamId: ID, action: 'steer', text: 'carry on' }, { awaitResult: true })
  })
  it('cancel stays token-capable (stopping work never widens it)', async () => {
    sendCommand.mockResolvedValue({ id: ID, state: 'cancelled' })
    await cancel({ params: { id: ID }, context: TOKEN })
    expect(sendCommand).toHaveBeenCalledTimes(1)
  })
})

describe('control routes → workstream-control command (awaited)', () => {
  it('cancel / resume / steer send the command and return the worker\'s DTO', async () => {
    sendCommand.mockResolvedValue({ id: ID, state: 'cancelled' })
    expect(await cancel({ params: { id: ID } })).toEqual({ id: ID, state: 'cancelled' })
    expect(sendCommand).toHaveBeenLastCalledWith('workstream-control', { workstreamId: ID, action: 'cancel' }, { awaitResult: true })
    await resume({ params: { id: ID }, context: SESSION })
    expect(sendCommand).toHaveBeenLastCalledWith('workstream-control', { workstreamId: ID, action: 'resume' }, { awaitResult: true })
    await steer({ params: { id: ID }, context: SESSION, body: { text: '  use the blue one ' } })
    expect(sendCommand).toHaveBeenLastCalledWith('workstream-control', { workstreamId: ID, action: 'steer', text: 'use the blue one' }, { awaitResult: true })
  })
  it('a worker that is down is a visible 504', async () => {
    sendCommand.mockRejectedValue(new CommandTimeoutError('workstream-control', 4, 10_000))
    await expect(cancel({ params: { id: ID } })).rejects.toMatchObject({ statusCode: 504 })
  })
  it('a malformed id never reaches the worker; an empty steer is a 400', async () => {
    await expect(cancel({ params: { id: 'nope' } })).rejects.toMatchObject({ statusCode: 404 })
    await expect(steer({ params: { id: ID }, context: SESSION, body: { text: '   ' } })).rejects.toMatchObject({ statusCode: 400 })
    expect(sendCommand).not.toHaveBeenCalled()
  })
})

describe('POST /api/workstreams (start from the UI)', () => {
  it('starts with no origin conversation and the given budget', async () => {
    startWorkstream.mockResolvedValue({ id: ID })
    await start({ context: SESSION, body: { goal: '  list my tasks  ', budget: { maxSteps: 20, maxWallMs: 600_000 } } })
    expect(startWorkstream).toHaveBeenCalledWith({ goal: 'list my tasks', budget: { maxSteps: 20, maxWallMs: 600_000 }, originConversationId: null })
  })
  it('a too-short goal or an out-of-bounds budget is a 400', async () => {
    await expect(start({ context: SESSION, body: { goal: 'x' } })).rejects.toMatchObject({ statusCode: 400 })
    await expect(start({ context: SESSION, body: { goal: 'fine goal', budget: { maxSteps: 0 } } })).rejects.toMatchObject({ statusCode: 400 })
    expect(startWorkstream).not.toHaveBeenCalled()
  })
})

describe('GET /api/workstreams ?limit', () => {
  it('is clamped to 100; a bad or absent value falls back to 100', async () => {
    for (const [q, want] of [['100000', 100], ['7', 7], ['abc', 100], [undefined, 100], ['-3', 100]] as const) {
      listWorkstreams.mockClear()
      await list({ query: q === undefined ? {} : { limit: q } })
      expect(listWorkstreams).toHaveBeenCalledWith({ states: undefined, limit: want, topLevel: true })
    }
  })
})

describe('GET /api/workstreams/:id/children paging (cycle 83 fix round 1)', () => {
  it('limit is clamped to 1–200 (default 200); offset to ≥ 0 (default 0)', async () => {
    const ID2 = '0b6f3c1e-5d2a-4f7b-9c8e-1a2b3c4d5e6f'
    for (const [q, want] of [
      [{}, { limit: 200, offset: 0 }], [{ limit: '100000' }, { limit: 200, offset: 0 }], [{ limit: '0' }, { limit: 1, offset: 0 }],
      [{ limit: '25', offset: '50' }, { limit: 25, offset: 50 }], [{ limit: 'x', offset: '-4' }, { limit: 200, offset: 0 }]
    ] as const) {
      childrenOf.mockClear()
      await childrenRoute({ params: { id: ID2 }, query: q })
      expect(childrenOf).toHaveBeenCalledWith(ID2, want)
    }
  })
})
