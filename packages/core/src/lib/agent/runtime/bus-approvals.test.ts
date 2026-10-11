// Cycle 81 Task 4 — the approval channel a worker run uses for a socket-originated run: the card's
// request goes out on the run's frame stream; the web's `approval-decision` command answers it here.
// These pin what moved out of server/api/voice/ws.ts with it: the turn-stream card (capped args),
// body-free outcome logging (cycle 79 I4), "always allow" only for allowlistable tools, the 120s
// chat auto-deny, and — new — abort denies (only) the aborted run's cards, `timeoutMs: null` waits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ addApproval: vi.fn(async () => ({})), recordEvent: vi.fn() }))
vi.mock('../../exec/approvals', async importOriginal => ({ ...(await importOriginal<typeof import('../../exec/approvals')>()), addApproval: m.addApproval }))
vi.mock('../../observability/record', () => ({ recordEvent: m.recordEvent }))

import { busApprovalChannel, decideBusApproval, pendingBusApprovals } from './bus-approvals'
import { registerTurnStream, releaseTurnStream } from './approvals'
import type { HubFrame } from '../../bus/events'

function harness(runId = 'run-1', opts: { signal?: AbortSignal; timeoutMs?: number | null } = {}) {
  const frames: HubFrame[] = []
  const ch = busApprovalChannel(runId, { publish: f => frames.push(f), ...opts })
  const lastRequestId = () => (frames.filter(f => f.type === 'approval').at(-1) as { requestId: string }).requestId
  return { frames, ch, lastRequestId }
}
const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers(); releaseTurnStream('run-1') })

describe('busApprovalChannel', () => {
  it('publishes the FULL request for every viewer, resumes on an approve decision, then resolves the card everywhere', async () => {
    const { frames, ch, lastRequestId } = harness()
    const p = ch({ tool: 'exec', command: 'ls -la', proposedPattern: 'ls *', allowlistable: true, title: 'Run this?', logSummary: 'ls' })
    const requestId = lastRequestId()
    expect(frames[0]).toEqual({ type: 'approval', requestId, tool: 'exec', command: 'ls -la', proposedPattern: 'ls *', allowlistable: true, title: 'Run this?', logSummary: 'ls' })
    expect(pendingBusApprovals('run-1')).toEqual([requestId])
    expect(decideBusApproval({ requestId, approved: true })).toBe(true)
    expect(await p).toEqual({ approved: true })
    expect(frames.at(-1)).toEqual({ type: 'approval-resolved', requestId })
    expect(pendingBusApprovals()).toEqual([])
    // Answered once: a second decision (another tab, a retried frame) is a no-op.
    expect(decideBusApproval({ requestId, approved: false })).toBe(false)
  })

  it('a deny decision denies; an unknown requestId changes nothing', async () => {
    const { ch, lastRequestId } = harness()
    const p = ch({ tool: 'exec', command: 'rm x', proposedPattern: 'rm *' })
    expect(decideBusApproval({ requestId: 'not-a-real-id', approved: true })).toBe(false)
    expect(decideBusApproval({ requestId: lastRequestId(), approved: false })).toBe(true)
    expect(await p).toEqual({ approved: false })
  })

  it('the approval request reaches the run\'s turn stream with the call\'s args (the card renders even if it beats tool-start)', async () => {
    const emit = vi.fn()
    registerTurnStream('run-1', { emit, finish: vi.fn(), error: vi.fn(), abort: vi.fn() })
    const { ch, lastRequestId } = harness()
    const p = ch({ tool: 'decide_review', command: 'approve — x', proposedPattern: '', allowlistable: false, callId: 'call-1', args: { id: 'rq-1', choice: 'approve' } })
    expect(emit).toHaveBeenCalledWith({ type: 'approval-request', approvalId: lastRequestId(), callId: 'call-1', name: 'decide_review', args: { id: 'rq-1', choice: 'approve' } })
    decideBusApproval({ requestId: lastRequestId(), approved: false })
    await p
  })

  it('the approval request\'s args are capped like tool-start args (a huge argument never ships whole)', async () => {
    const emit = vi.fn()
    registerTurnStream('run-1', { emit, finish: vi.fn(), error: vi.fn(), abort: vi.fn() })
    const { ch, lastRequestId } = harness()
    const p = ch({ tool: 'exec', command: 'cat', proposedPattern: 'cat *', allowlistable: true, callId: 'call-big', args: { command: 'x'.repeat(20_000) } })
    const sent = emit.mock.calls.at(-1)![0] as { args: Record<string, unknown> }
    expect(sent.args).toMatchObject({ truncated: true })
    expect(JSON.stringify(sent.args).length).toBeLessThan(5000)
    decideBusApproval({ requestId: lastRequestId(), approved: false })
    await p
  })

  it('I4 (cycle 79 review): approve/deny logs the body-free logSummary when a tool sets one, never the raw command', async () => {
    const { ch, lastRequestId } = harness()
    const req = { tool: 'gmail_send', command: 'From: a@b.com\n\nsecret draft body', proposedPattern: '', logSummary: 'gmail_send: account=work draftId=d1 to=a@b.com subjectChars=3' }
    const p = ch(req)
    decideBusApproval({ requestId: lastRequestId(), approved: true })
    await p
    const call = m.recordEvent.mock.calls.find(c => (c[0] as { meta?: Record<string, unknown> }).meta?.outcome === 'approve')
    expect(call?.[0]).toMatchObject({ meta: { command: req.logSummary } })
    expect(JSON.stringify(m.recordEvent.mock.calls)).not.toContain('secret draft body')
  })

  it('a chat approval auto-denies at 120s, logging the body-free logSummary and resolving the card', async () => {
    vi.useFakeTimers()
    const { frames, ch, lastRequestId } = harness()
    const req = { tool: 'gmail_send', command: 'From: a@b.com\n\nsecret draft body', proposedPattern: '', logSummary: 'gmail_send: draftId=d1' }
    let settled = false
    const p = ch(req).then((v) => { settled = true; return v })
    await vi.advanceTimersByTimeAsync(119_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await p).toEqual({ approved: false })
    expect(frames.at(-1)).toEqual({ type: 'approval-resolved', requestId: lastRequestId() })
    const call = m.recordEvent.mock.calls.find(c => (c[0] as { meta?: Record<string, unknown> }).meta?.outcome === 'timeout')
    expect(call?.[0]).toMatchObject({ meta: { command: req.logSummary } })
    expect(JSON.stringify(m.recordEvent.mock.calls)).not.toContain('secret draft body')
  })

  it('timeoutMs: null (the workstream hook) waits past 120s until Tony decides', async () => {
    vi.useFakeTimers()
    const { ch, lastRequestId } = harness('run-1', { timeoutMs: null })
    let settled = false
    const p = ch({ tool: 'exec', command: 'ls', proposedPattern: 'ls *' }).then((v) => { settled = true; return v })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(settled).toBe(false)
    decideBusApproval({ requestId: lastRequestId(), approved: true })
    expect(await p).toEqual({ approved: true })
  })

  it('"always allow" is saved only for an allowlistable tool — a crafted remember for decide_review is refused', async () => {
    const { ch, lastRequestId } = harness()
    const decide = ch({ tool: 'decide_review', command: 'approve — x', proposedPattern: '', allowlistable: false })
    decideBusApproval({ requestId: lastRequestId(), approved: true, remember: true, pattern: 'approve *' })
    expect(await decide).toEqual({ approved: true })
    expect(m.addApproval).not.toHaveBeenCalled()
    expect(m.recordEvent.mock.calls.some(c => (c[0] as { meta?: Record<string, unknown> }).meta?.outcome === 'remember-refused')).toBe(true)
    // exec (allowlistable) still saves the pattern — the proposed one when none is sent.
    const exec = ch({ tool: 'exec', command: 'git status', proposedPattern: 'git *', allowlistable: true })
    decideBusApproval({ requestId: lastRequestId(), approved: true, remember: true })
    expect(await exec).toEqual({ approved: true })
    expect(m.addApproval).toHaveBeenCalledWith({ pattern: 'git *', tool: 'exec' })
  })

  it('aborting a run denies ITS open cards at once (so a parked run unwinds for Stop / clear) and leaves other runs\' cards alone', async () => {
    const acA = new AbortController()
    const a = harness('run-A', { signal: acA.signal })
    const b = harness('run-B', { signal: new AbortController().signal })
    let bDone = false
    const pa = a.ch({ tool: 'exec', command: 'ls', proposedPattern: 'ls *' })
    const pb = b.ch({ tool: 'exec', command: 'ls', proposedPattern: 'ls *' }).then((v) => { bDone = true; return v })
    acA.abort()
    expect(await pa).toEqual({ approved: false })
    expect(a.frames.at(-1)).toEqual({ type: 'approval-resolved', requestId: a.lastRequestId() })
    await flush()
    expect(bDone).toBe(false)
    expect(pendingBusApprovals('run-B')).toEqual([b.lastRequestId()])
    decideBusApproval({ requestId: b.lastRequestId(), approved: false })
    await pb
  })

  it('a run already aborted never shows a card', async () => {
    const ac = new AbortController(); ac.abort()
    const { frames, ch } = harness('run-1', { signal: ac.signal })
    expect(await ch({ tool: 'exec', command: 'ls', proposedPattern: 'ls *' })).toEqual({ approved: false })
    expect(frames).toEqual([])
  })
})
