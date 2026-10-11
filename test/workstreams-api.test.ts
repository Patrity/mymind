// Cycle 81 Task 6: the /api/workstreams routes' error mapping and the control round trip — the cap
// refusal reaches the UI as a 409 with readable text, a silent worker as a 504 (never a quiet OK),
// and controls go through the `workstream-control` command (the worker holds the segment).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number; statusMessage?: string; data?: unknown }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)
vi.stubGlobal('getRouterParam', (e: { params?: Record<string, string> }, k: string) => e.params?.[k])

const sendCommand = vi.fn()
vi.mock('@mymind/core/lib/bus/commands', async (orig) => ({ ...(await orig<typeof import('@mymind/core/lib/bus/commands')>()), sendCommand: (...a: unknown[]) => sendCommand(...a) }))
const startWorkstream = vi.fn()
vi.mock('@mymind/core/lib/agent/workstreams/loop', async (orig) => ({ ...(await orig<typeof import('@mymind/core/lib/agent/workstreams/loop')>()), startWorkstream: (...a: unknown[]) => startWorkstream(...a) }))

const { CommandFailedError, CommandTimeoutError } = await import('@mymind/core/lib/bus/commands')
const { WorkstreamCapError } = await import('@mymind/core/lib/agent/workstreams/loop')
const { capMessage, workstreamError } = await import('../server/utils/workstreams-http')
type H = (e: unknown) => Promise<unknown>
const cancel = (await import('../server/api/workstreams/[id]/cancel.post')).default as H
const resume = (await import('../server/api/workstreams/[id]/resume.post')).default as H
const steer = (await import('../server/api/workstreams/[id]/steer.post')).default as H
const start = (await import('../server/api/workstreams/index.post')).default as H

const ID = '0b6f3c1e-5d2a-4f7b-9c8e-1a2b3c4d5e6f'
const CAP = 'There are already 3 workstreams in progress (the limit is 3): "a", "b", "c". Tell Tony — one has to finish or be cancelled before another can start.'
type HttpErr = Error & { statusCode: number; data: { code: string; message: string } }

beforeEach(() => { sendCommand.mockReset(); startWorkstream.mockReset() })

describe('workstreamError', () => {
  it('the cap (thrown here or relayed by the worker) is a 409 "cap" without the note to the model', () => {
    for (const err of [new WorkstreamCapError(CAP), new CommandFailedError('workstream-control', 1, CAP)]) {
      const e = workstreamError(err) as HttpErr
      expect(e.statusCode).toBe(409)
      expect(e.data.code).toBe('cap')
      expect(e.data.message).toBe('There are already 3 workstreams in progress (the limit is 3): "a", "b", "c". Finish or cancel one first.')
    }
    const resumeCap = 'There are already 3 workstreams in progress (the limit is 3) — finish or cancel one before resuming this one.'
    expect((workstreamError(new CommandFailedError('workstream-control', 2, resumeCap)) as HttpErr).data).toEqual({ code: 'cap', message: resumeCap })
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
  it('capMessage drops only the instruction', () => {
    expect(capMessage('X. Tell Tony — y')).toBe('X. Finish or cancel one first.')
  })
})

describe('control routes → workstream-control command (awaited)', () => {
  it('cancel / resume / steer send the command and return the worker\'s DTO', async () => {
    sendCommand.mockResolvedValue({ id: ID, state: 'cancelled' })
    expect(await cancel({ params: { id: ID } })).toEqual({ id: ID, state: 'cancelled' })
    expect(sendCommand).toHaveBeenLastCalledWith('workstream-control', { workstreamId: ID, action: 'cancel' }, { awaitResult: true })
    await resume({ params: { id: ID } })
    expect(sendCommand).toHaveBeenLastCalledWith('workstream-control', { workstreamId: ID, action: 'resume' }, { awaitResult: true })
    await steer({ params: { id: ID }, body: { text: '  use the blue one ' } })
    expect(sendCommand).toHaveBeenLastCalledWith('workstream-control', { workstreamId: ID, action: 'steer', text: 'use the blue one' }, { awaitResult: true })
  })
  it('a resume refused at the cap is a 409 cap', async () => {
    sendCommand.mockRejectedValue(new CommandFailedError('workstream-control', 3, 'There are already 3 workstreams in progress (the limit is 3) — finish or cancel one before resuming this one.'))
    await expect(resume({ params: { id: ID } })).rejects.toMatchObject({ statusCode: 409, data: { code: 'cap' } })
  })
  it('a worker that is down is a visible 504', async () => {
    sendCommand.mockRejectedValue(new CommandTimeoutError('workstream-control', 4, 10_000))
    await expect(cancel({ params: { id: ID } })).rejects.toMatchObject({ statusCode: 504 })
  })
  it('a malformed id never reaches the worker; an empty steer is a 400', async () => {
    await expect(cancel({ params: { id: 'nope' } })).rejects.toMatchObject({ statusCode: 404 })
    await expect(steer({ params: { id: ID }, body: { text: '   ' } })).rejects.toMatchObject({ statusCode: 400 })
    expect(sendCommand).not.toHaveBeenCalled()
  })
})

describe('POST /api/workstreams (start from the UI)', () => {
  it('starts with no origin conversation and the given budget', async () => {
    startWorkstream.mockResolvedValue({ id: ID })
    await start({ body: { goal: '  list my tasks  ', budget: { maxSteps: 20, maxWallMs: 600_000 } } })
    expect(startWorkstream).toHaveBeenCalledWith({ goal: 'list my tasks', budget: { maxSteps: 20, maxWallMs: 600_000 }, originConversationId: null })
  })
  it('over the cap → 409 cap with readable text', async () => {
    startWorkstream.mockRejectedValue(new WorkstreamCapError(CAP))
    await expect(start({ body: { goal: 'something' } })).rejects.toMatchObject({ statusCode: 409, data: { code: 'cap', message: expect.stringMatching(/Finish or cancel one first\.$/) } })
  })
  it('a too-short goal or an out-of-bounds budget is a 400', async () => {
    await expect(start({ body: { goal: 'x' } })).rejects.toMatchObject({ statusCode: 400 })
    await expect(start({ body: { goal: 'fine goal', budget: { maxSteps: 0 } } })).rejects.toMatchObject({ statusCode: 400 })
    expect(startWorkstream).not.toHaveBeenCalled()
  })
})
