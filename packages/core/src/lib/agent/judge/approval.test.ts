// Cycle 84 Task 2: the judge of one approval request (approval.ts) wired into the bus approval channel
// (runtime/bus-approvals.ts) — the card first, then the rule tier + verdict behind it; Smart Approvals
// resolves the request itself only when the predicate holds at the moment the verdict lands; first
// decision wins (Tony, the timeout, Stop, the judge); a late verdict is recorded and changes nothing.
// Every seam is faked (no DB, no model): settings, rule tier, verdict, the audit store, the gmail pin.
import { afterEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ recordEvent: vi.fn() }))
vi.mock('../../observability/record', () => ({ recordEvent: m.recordEvent, withSpan: (_s: unknown, fn: () => unknown) => fn() }))

import { createApprovalJudge, defaultApprovalJudgeDeps, type ApprovalJudgeDeps } from './approval'
import { busApprovalChannel, decideBusApproval, pendingBusApprovals } from '../runtime/bus-approvals'
import { getJudgeSettings } from '../agent-settings'
import { decideReviewTool } from '../tools/reviews'
import { errorVerdict } from './verdict'
import type { HubFrame } from '../../bus/events'
import type { AgentTool } from '../types'
import type { JudgeSettings, JudgeVerdict, RuleVerdict } from './types'
import type { RecordVerdictInput } from './store'

const ON: JudgeSettings = { enabled: true, smartApprovals: { workstreams: true, chat: false }, confidence: 0.9 }
const APPROVE: JudgeVerdict = { risk: 'low', recommendation: 'approve', confidence: 0.95, reasons: ['routine service restart'], model: 'J', latencyMs: 12 }
const EXEC_LIKE: Pick<AgentTool, 'name' | 'description' | 'outbound' | 'humanOnly'> = { name: 'calendar_rsvp', description: 'RSVP to an event' }
const judgeEvents = () => m.recordEvent.mock.calls.map(c => c[0] as { name: string; meta: Record<string, unknown> }).filter(e => e.name.startsWith('judge:'))
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

interface SetupOpts {
  surface?: 'workstream' | 'chat' | 'headless'
  settings?: JudgeSettings
  tool?: Pick<AgentTool, 'name' | 'description' | 'outbound' | 'humanOnly'>
  rule?: () => Promise<RuleVerdict>
  tainted?: boolean
  timeoutMs?: number | null
  signal?: AbortSignal
  pinned?: () => string | undefined
  isTainted?: () => boolean
  fresh?: () => Promise<JudgeSettings>
  ruleTimeoutMs?: number
  verdictTimeoutMs?: number
}

function setup(o: SetupOpts = {}) {
  const store = { order: [] as string[], verdicts: [] as RecordVerdictInput[], decisions: [] as Array<[string, string, string]> }
  const verdict = deferred<JudgeVerdict>()
  const deps: ApprovalJudgeDeps = {
    settings: async () => o.settings ?? ON,
    freshSettings: o.fresh ?? (async () => o.settings ?? ON),
    ruleTimeoutMs: o.ruleTimeoutMs ?? 10_000,
    verdictTimeoutMs: o.verdictTimeoutMs ?? 10_000,
    rule: vi.fn(o.rule ?? (async (): Promise<RuleVerdict> => ({ floor: 'review', reasons: [] }))),
    verdict: vi.fn(async () => verdict.promise),
    recordVerdict: async (i) => { store.order.push(i.verdict ? 'verdict' : 'rule'); store.verdicts.push(i) },
    recordDecision: async (n, d, b) => { store.order.push('decision'); store.decisions.push([n, d, b]); return true },
    pinnedSendMessageId: o.pinned ?? (() => undefined),
    ruleContextWaitMs: 20
  }
  const frames: HubFrame[] = []
  const waits: boolean[] = []
  const evals: boolean[] = []
  const ch = busApprovalChannel('run-j', {
    publish: f => frames.push(f), timeoutMs: o.timeoutMs === undefined ? null : o.timeoutMs, signal: o.signal,
    onWaiting: (_id, w) => waits.push(w), onEvaluating: (_id, e) => evals.push(e)
  })
  const tool = o.tool ?? EXEC_LIKE
  const judge = createApprovalJudge({
    tool, input: { eventId: 'e1', response: 'accepted' }, req: { title: 'Send RSVP?', command: 'RSVP accepted to Standup' },
    nonce: 'nonce-1', surface: o.surface ?? 'workstream', runId: 'run-j', workstreamId: 'ws-1', goal: 'keep my calendar tidy',
    isTainted: o.isTainted ?? (() => o.tainted === true), signal: o.signal
  }, deps)
  let settledValue: { approved: boolean } | undefined
  const p = ch({ tool: tool.name, command: 'RSVP accepted to Standup', proposedPattern: '', title: 'Send RSVP?' }, { judge })
    .then((v) => { settledValue = v; return v })
  const requestId = (frames[0] as { requestId: string }).requestId
  const verdictFrames = () => frames.filter(f => f.type === 'approval-verdict') as Array<Extract<HubFrame, { type: 'approval-verdict' }>>
  return { p, judge, deps, store, verdict, frames, waits, evals, requestId, verdictFrames, settled: () => settledValue }
}

afterEach(() => {
  for (const id of pendingBusApprovals()) decideBusApproval({ requestId: id, approved: false })
  m.recordEvent.mockClear()
})

describe('approval judge on the bus channel', () => {
  it('the card goes out first; only then do the rule tier and the judge run (C3)', async () => {
    const deps = { ...defaultApprovalJudgeDeps, settings: vi.fn(async () => ON), freshSettings: vi.fn(async () => ON), rule: vi.fn(async () => ({ floor: 'review' as const, reasons: [] })), verdict: vi.fn(async () => APPROVE) }
    const judge = createApprovalJudge({ tool: EXEC_LIKE, input: {}, req: { command: 'x' }, nonce: 'n0', surface: 'workstream', isTainted: () => false }, deps)
    await flush()
    expect(deps.settings).not.toHaveBeenCalled()
    expect(deps.rule).not.toHaveBeenCalled()
    expect(deps.verdict).not.toHaveBeenCalled()
    expect(judge.view()).toBeNull()
    const s = setup()
    expect(s.frames[0]).toMatchObject({ type: 'approval', requestId: s.requestId })
    await flush()
    expect(s.deps.rule).toHaveBeenCalledTimes(1)
    expect(s.deps.verdict).toHaveBeenCalledTimes(1)
  })

  it('workstream: the verdict streams to the card, Smart Approvals resolves it as the judge, the audit reads rule → verdict → auto', async () => {
    const s = setup()
    await flush()
    // Evaluating, not waiting on Tony: no attention, no texts while the judge decides.
    expect(s.evals).toEqual([true])
    expect(s.waits).toEqual([])
    expect(s.verdictFrames().at(-1)!.judge).toEqual({ rule: { floor: 'review', reasons: [] }, verdict: null, pending: true, autoPossible: true })
    // The judge reads the card as Tony sees it, the goal, and the rule floor.
    expect(vi.mocked(s.deps.verdict).mock.calls[0]![0]).toMatchObject({
      tool: 'calendar_rsvp', description: 'RSVP to an event', call: 'Send RSVP?\nRSVP accepted to Standup', goal: 'keep my calendar tidy', rule: { floor: 'review' }
    })
    s.verdict.resolve(APPROVE)
    expect(await s.p).toEqual({ approved: true })
    expect(s.verdictFrames().at(-1)!.judge).toMatchObject({ verdict: { risk: 'low', recommendation: 'approve', confidence: 0.95, reasons: ['routine service restart'] }, pending: false, autoPossible: true })
    expect(s.frames.at(-1)).toEqual({ type: 'approval-resolved', requestId: s.requestId, decidedBy: 'judge', auto: { decidedBy: 'judge', confidence: 0.95, reason: 'routine service restart' } })
    expect(s.evals).toEqual([true, false])
    expect(s.waits).toEqual([])                                 // Tony was never asked to wait
    expect(s.judge.autoNote()).toEqual({ decidedBy: 'judge', confidence: 0.95, reason: 'routine service restart' })
    await s.judge.writes()
    expect(s.store.order).toEqual(['rule', 'verdict', 'decision'])
    expect(s.store.decisions).toEqual([['nonce-1', 'auto', 'judge']])
    expect(s.store.verdicts[0]).toMatchObject({ nonce: 'nonce-1', runId: 'run-j', workstreamId: 'ws-1', tool: 'calendar_rsvp', rule: { floor: 'review' } })
    expect(judgeEvents().map(e => e.name)).toEqual(['judge:verdict', 'judge:auto-approve'])
    // Activity rows never carry the verdict's reasons (model output) next to the command.
    expect(JSON.stringify(m.recordEvent.mock.calls)).not.toContain('routine service restart')
  })

  it('chat stays manual by default: the verdict shows, Tony decides', async () => {
    const s = setup({ surface: 'chat' })
    await flush()
    expect(s.evals).toEqual([])
    expect(s.waits).toEqual([true])                             // a human is needed at once
    s.verdict.resolve(APPROVE)
    await flush()
    expect(s.settled()).toBeUndefined()
    expect(s.verdictFrames().at(-1)!.judge).toMatchObject({ verdict: { recommendation: 'approve' }, autoPossible: false })
    expect(decideBusApproval({ requestId: s.requestId, approved: true })).toBe(true)
    expect(await s.p).toEqual({ approved: true })
    expect(s.frames.at(-1)).toEqual({ type: 'approval-resolved', requestId: s.requestId, decidedBy: 'tony' })
    await s.judge.writes()
    expect(s.store.decisions).toEqual([['nonce-1', 'approved', 'tony']])
    expect(s.judge.autoNote()).toBeNull()
  })

  it('chat with Smart Approvals switched on → auto-approved', async () => {
    const s = setup({ surface: 'chat', settings: { ...ON, smartApprovals: { workstreams: true, chat: true } } })
    await flush()
    s.verdict.resolve(APPROVE)
    expect(await s.p).toEqual({ approved: true })
    await s.judge.writes()
    expect(s.store.decisions).toEqual([['nonce-1', 'auto', 'judge']])
  })

  it('a workstream with its switch off → manual', async () => {
    const s = setup({ settings: { ...ON, smartApprovals: { workstreams: false, chat: false } } })
    await flush()
    expect(s.waits).toEqual([true])
    s.verdict.resolve(APPROVE)
    await flush()
    expect(s.settled()).toBeUndefined()
  })

  it('headless never auto-runs, whatever the settings say', async () => {
    const s = setup({ surface: 'headless', settings: { ...ON, smartApprovals: { workstreams: true, chat: true } } })
    s.verdict.resolve({ ...APPROVE, confidence: 1 })
    await flush()
    expect(s.settled()).toBeUndefined()
    expect(s.waits).toEqual([true])
  })

  it('an outbound call in a tainted run never auto-runs', async () => {
    const s = setup({ tool: { name: 'web_fetch', description: 'fetch', outbound: true }, tainted: true })
    await flush()
    expect(s.evals).toEqual([])
    s.verdict.resolve({ ...APPROVE, confidence: 1 })
    await flush()
    expect(s.settled()).toBeUndefined()
    expect(s.verdictFrames().at(-1)!.judge.autoPossible).toBe(false)
  })

  it('a tool that is NOT outbound (outbound undefined) may still auto-run in a tainted run (outbound: tool.outbound === true)', async () => {
    const s = setup({ tool: { name: 'calendar_rsvp', description: 'rsvp' }, tainted: true })
    await flush()
    s.verdict.resolve(APPROVE)
    expect(await s.p).toEqual({ approved: true })
  })

  it.each([['critical'], ['high'], ['deny']] as const)('a rule floor of %s never auto-runs — Tony is asked as soon as the rule lands, before the verdict', async (floor) => {
    const s = setup({ rule: async () => ({ floor, reasons: ['why'] }) })
    await flush()
    expect(s.waits).toEqual([true])                             // the verdict is still pending
    expect(s.verdictFrames().at(-1)!.judge).toMatchObject({ rule: { floor, reasons: ['why'] }, verdict: null, pending: true, autoPossible: false })
    s.verdict.resolve({ ...APPROVE, confidence: 1 })
    await flush()
    expect(s.settled()).toBeUndefined()
  })

  it('humanOnly (decide_review) never auto-runs, but still shows the verdict', async () => {
    const s = setup({ tool: { name: 'decide_review', description: 'decide', humanOnly: true } })
    await flush()
    expect(s.waits).toEqual([true])
    s.verdict.resolve({ ...APPROVE, confidence: 1 })
    await flush()
    expect(s.settled()).toBeUndefined()
    expect(s.verdictFrames().at(-1)!.judge.verdict).toMatchObject({ recommendation: 'approve' })
  })

  it('an invalid stored threshold means no auto-approval, even for a verdict of exactly 1.0', async () => {
    const s = setup({ settings: { ...ON, confidence: Number.NaN } })
    await flush()
    expect(s.waits).toEqual([true])
    s.verdict.resolve({ ...APPROVE, confidence: 1 })
    await flush()
    expect(s.settled()).toBeUndefined()
  })

  it('a judge error (timeout) is a review: Tony is asked', async () => {
    const s = setup()
    await flush()
    expect(s.waits).toEqual([])
    s.verdict.resolve(errorVerdict('judge timed out', 60_000))
    await flush()
    expect(s.settled()).toBeUndefined()
    expect(s.evals).toEqual([true, false])
    expect(s.waits).toEqual([true])
    expect(s.verdictFrames().at(-1)!.judge).toMatchObject({ verdict: { error: 'judge timed out', recommendation: 'review' }, autoPossible: false })
  })

  it('a verdict landing after Tony decided is recorded and changes nothing', async () => {
    const s = setup()
    await flush()
    expect(decideBusApproval({ requestId: s.requestId, approved: false })).toBe(true)
    expect(await s.p).toEqual({ approved: false })
    s.verdict.resolve(APPROVE)
    await flush()
    await s.judge.writes()
    expect(s.store.decisions).toEqual([['nonce-1', 'denied', 'tony']])
    expect(s.store.verdicts.at(-1)!.verdict).toMatchObject({ recommendation: 'approve' })
    expect(s.judge.autoNote()).toBeNull()
    expect(s.frames.filter(f => f.type === 'approval-resolved')).toHaveLength(1)
    expect(judgeEvents().map(e => e.meta.blocker)).toEqual(['decided'])
  })

  it('the chat 120 s timeout beats a late verdict: denied as a timeout, the verdict only recorded', async () => {
    const s = setup({ surface: 'chat', settings: { ...ON, smartApprovals: { workstreams: true, chat: true } }, timeoutMs: 30 })
    expect(await s.p).toEqual({ approved: false })
    expect(s.frames.at(-1)).toEqual({ type: 'approval-resolved', requestId: s.requestId, decidedBy: 'timeout' })
    s.verdict.resolve(APPROVE)
    await flush()
    await s.judge.writes()
    expect(s.store.decisions).toEqual([['nonce-1', 'timeout', 'timeout']])
    expect(s.store.order).toContain('verdict')
  })

  it('Stop during evaluation denies at once, cancels the judge, and a late approve does nothing', async () => {
    const ac = new AbortController()
    const s = setup({ signal: ac.signal })
    await flush()
    expect(s.evals).toEqual([true])
    ac.abort()
    expect(await s.p).toEqual({ approved: false })
    expect(s.evals).toEqual([true, false])
    expect(s.waits).toEqual([])
    expect(vi.mocked(s.deps.verdict).mock.calls[0]![0].signal?.aborted).toBe(true)
    s.verdict.resolve(APPROVE)
    await flush()
    await s.judge.writes()
    // C3: Stop is not Tony's "no".
    expect(s.store.decisions).toEqual([['nonce-1', 'cancelled', 'system']])
    expect(s.frames.at(-1)).toEqual({ type: 'approval-resolved', requestId: s.requestId, decidedBy: 'system' })
  })

  it('a decision made before the rule tier lands waits for its row (recordVerdict before recordDecision)', async () => {
    const rule = deferred<RuleVerdict>()
    const s = setup({ rule: () => rule.promise })
    await flush()
    decideBusApproval({ requestId: s.requestId, approved: true })
    await s.p
    await flush()
    expect(s.store.order).toEqual([])                           // the decision is held for the row
    rule.resolve({ floor: 'review', reasons: [] })
    s.verdict.resolve(APPROVE)
    await flush()
    await s.judge.writes()
    expect(s.store.order[0]).toBe('rule')
    expect(s.store.order).toContain('decision')
    expect(s.store.order.indexOf('decision')).toBeGreaterThan(0)
    expect(s.store.decisions).toEqual([['nonce-1', 'approved', 'tony']])
  })

  it('judge off: no verdict frames, no audit, Tony decides at once', async () => {
    const s = setup({ settings: { ...ON, enabled: false } })
    await flush()
    expect(s.waits).toEqual([true])
    expect(s.verdictFrames()).toEqual([])
    expect(s.deps.rule).not.toHaveBeenCalled()
    expect(s.deps.verdict).not.toHaveBeenCalled()
    decideBusApproval({ requestId: s.requestId, approved: true })
    await s.p
    await s.judge.writes()
    expect(s.store.order).toEqual([])
    expect(await s.judge.enabled()).toBe(false)
  })

  describe('gmail_send: the pinned draft revision (nonce binding)', () => {
    const gmail = { name: 'gmail_send', description: 'send a draft' }
    const checked = async (): Promise<RuleVerdict> => ({ floor: 'review', reasons: [], boundMessageId: 'm1' })

    it('the pin still on the checked revision → auto-approvable', async () => {
      const s = setup({ tool: gmail, rule: checked, pinned: () => 'm1' })
      await flush()
      s.verdict.resolve(APPROVE)
      expect(await s.p).toEqual({ approved: true })
    })

    it('the pin gone (another approval / restart) before the verdict lands → never auto', async () => {
      let pin: string | undefined = 'm1'
      const s = setup({ tool: gmail, rule: checked, pinned: () => pin })
      await flush()
      expect(s.verdictFrames().at(-1)!.judge.rule).toEqual({ floor: 'review', reasons: [] })
      pin = undefined
      s.verdict.resolve(APPROVE)
      await flush()
      expect(s.settled()).toBeUndefined()
      expect(judgeEvents()).toMatchObject([{ name: 'judge:verdict', meta: { auto: false, blocker: 'nonce-changed' } }])
    })

    it('a pin for a different revision than the one checked → high at once', async () => {
      const s = setup({ tool: gmail, rule: checked, pinned: () => 'm2' })
      await flush()
      expect(s.verdictFrames().at(-1)!.judge.rule).toEqual({ floor: 'high', reasons: ['the draft changed after its recipients were checked'] })
      expect(s.waits).toEqual([true])
    })
  })

  it('I3: the run becomes tainted WHILE an outbound call is judged → never auto (taint read at decision)', async () => {
    let tainted = false
    const s = setup({ tool: { name: 'web_fetch', description: 'fetch', outbound: true }, isTainted: () => tainted })
    await flush()
    expect(s.evals).toEqual([true])                             // eligible at the start (untainted)
    tainted = true                                              // a parallel `taints` read completed
    s.verdict.resolve({ ...APPROVE, confidence: 1 })
    await flush()
    expect(s.settled()).toBeUndefined()
    expect(s.waits).toEqual([true])
    expect(judgeEvents()).toMatchObject([{ name: 'judge:verdict', meta: { auto: false, blocker: 'tainted-outbound' } }])
  })

  it('M1: Smart Approvals switched off while the card was judged → no auto (settings re-read at decision)', async () => {
    const s = setup({ fresh: async () => ({ ...ON, smartApprovals: { workstreams: false, chat: false } }) })
    await flush()
    expect(s.evals).toEqual([true])
    s.verdict.resolve(APPROVE)
    await flush()
    expect(s.settled()).toBeUndefined()
    expect(judgeEvents()).toMatchObject([{ meta: { blocker: 'surface-disabled' } }])
  })

  it('M1: settings unreadable at decision → no auto', async () => {
    const s = setup({ fresh: async () => { throw new Error('db down') } })
    await flush()
    s.verdict.resolve(APPROVE)
    await flush()
    expect(s.settled()).toBeUndefined()
    expect(judgeEvents()).toMatchObject([{ meta: { blocker: 'judge-disabled' } }])
  })

  it('I2: a rule tier that hangs is cut off — floor high, Tony asked, never stuck evaluating', async () => {
    const t = setup({ ruleTimeoutMs: 30, rule: () => new Promise<RuleVerdict>(() => {}) })
    await new Promise(r => setTimeout(r, 60))
    expect(t.verdictFrames().at(-1)!.judge.rule).toEqual({ floor: 'high', reasons: ['rule check timed out'] })
    expect(t.waits).toEqual([true])
    expect(t.evals).toEqual([true, false])
    t.verdict.resolve(APPROVE)
    await flush()
    expect(t.settled()).toBeUndefined()
    await t.judge.writes()
    expect(t.store.verdicts[0]!.rule).toEqual({ floor: 'high', reasons: ['rule check timed out'] })
  })

  it('I2: the rule tier signal aborts when it is cut off (its Gmail lookups stop)', async () => {
    let ruleSignal: AbortSignal | undefined
    const t = setup({ ruleTimeoutMs: 20, rule: undefined })
    vi.mocked(t.deps.rule).mockClear()
    const deps = { ...t.deps, ruleTimeoutMs: 20, rule: vi.fn(async (_t: unknown, _i: unknown, signal: AbortSignal) => { ruleSignal = signal; return new Promise<RuleVerdict>(() => {}) }) }
    createApprovalJudge({ tool: EXEC_LIKE, input: {}, req: { command: 'x' }, nonce: 'n-sig', surface: 'workstream', isTainted: () => false }, deps).start(() => {})
    await new Promise(r => setTimeout(r, 50))
    expect(ruleSignal?.aborted).toBe(true)
  })

  it('M4: a verdict seam that never answers is cut off by the judge itself → an error verdict, Tony asked', async () => {
    const s = setup({ verdictTimeoutMs: 30 })                   // s.verdict is never resolved
    await new Promise(r => setTimeout(r, 70))
    expect(s.verdictFrames().at(-1)!.judge.verdict).toMatchObject({ error: 'judge timed out', recommendation: 'review' })
    expect(s.waits).toEqual([true])
    expect(s.settled()).toBeUndefined()
  })

  it('decide_review ("Tony confirms every call") is humanOnly; no other dangerous tool needs to be', () => {
    expect(decideReviewTool.humanOnly).toBe(true)
  })

  it('the default seams are the real ones (settings getter)', () => {
    expect(defaultApprovalJudgeDeps.settings).toBe(getJudgeSettings)
  })
})
