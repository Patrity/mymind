import { describe, expect, it } from 'vitest'
import { addApproval, approvalFor, canApprove, orphanApprovals, removeApproval, resolveApproval, setApprovalVerdict, type PendingApprovals } from './approvals'
import { mapServerMessage } from '../voice/messages'

const frame = (requestId: string, command: string) =>
  ({ type: 'approval', requestId, tool: 'gmail_send', title: 'Send this email?', command, proposedPattern: '', allowlistable: false }) as never

/** The exact fold useVoice applies to incoming frames. */
function apply(state: PendingApprovals, m: unknown): PendingApprovals {
  const fx = mapServerMessage(m as never, false, null)
  if (fx.approval) state = addApproval(state, fx.approval)
  if (fx.approvalVerdict) state = setApprovalVerdict(state, fx.approvalVerdict.requestId, fx.approvalVerdict.judge)
  if (fx.approvalResolved) state = resolveApproval(state, fx.approvalResolved, fx.approvalAuto)
  return state
}

describe('pending approvals (per request — cycle 79 fix wave I1)', () => {
  it('two concurrent approval frames each keep their own details', () => {
    let s: PendingApprovals = {}
    s = apply(s, frame('r1', 'To: ann@example.com\n\nFIRST'))
    s = apply(s, frame('r2', 'To: bo@example.com\n\nSECOND'))
    expect(approvalFor(s, 'r1')?.command).toContain('FIRST')
    expect(approvalFor(s, 'r2')?.command).toContain('SECOND')
  })

  it('resolving one request leaves the other intact', () => {
    let s: PendingApprovals = {}
    s = apply(s, frame('r1', 'FIRST'))
    s = apply(s, frame('r2', 'SECOND'))
    s = apply(s, { type: 'approval-resolved', requestId: 'r1' })
    expect(approvalFor(s, 'r1')).toBeNull()
    expect(approvalFor(s, 'r2')?.command).toBe('SECOND')
    s = removeApproval(s, 'r2')
    expect(s).toEqual({})
  })

  it('removing an unknown id is a no-op (same object)', () => {
    const s = addApproval({}, { requestId: 'r1', tool: 'exec', command: 'ls', proposedPattern: 'ls *' })
    expect(removeApproval(s, 'nope')).toBe(s)
  })

  it('approvalFor misses on an absent state or id', () => {
    expect(approvalFor(null, 'r1')).toBeNull()
    expect(approvalFor({}, undefined)).toBeNull()
  })

  it('a non-exec card without details cannot be approved; exec can (its args are the command)', () => {
    expect(canApprove('gmail_send', null)).toBe(false)
    expect(canApprove('calendar_rsvp', null)).toBe(false)
    expect(canApprove('exec', null)).toBe(true)
    expect(canApprove('gmail_send', { requestId: 'r', tool: 'gmail_send', command: 'x', proposedPattern: '' })).toBe(true)
  })
})

describe('orphanApprovals (a card with no tool part on screen — e.g. a workstream card in its origin chat)', () => {
  const d = (requestId: string) => ({ requestId, tool: 'exec', command: 'ls', proposedPattern: 'ls *' })
  const pending: PendingApprovals = { a: d('a'), b: d('b') }
  const msgs = [{ parts: [
    { type: 'text' },
    { type: 'dynamic-tool', state: 'approval-requested', approval: { id: 'a' } },
    { type: 'dynamic-tool', state: 'output-available', approval: { id: 'b' } }
  ] }]
  it('returns only the pending requests no approval-requested part carries', () => {
    expect(orphanApprovals(pending, msgs).map(x => x.requestId)).toEqual(['b'])
  })
  it('none pending, or every one on a part → nothing', () => {
    expect(orphanApprovals({}, msgs)).toEqual([])
    expect(orphanApprovals(null, msgs)).toEqual([])
    expect(orphanApprovals({ a: d('a') }, msgs)).toEqual([])
  })
  it('with no transcript at all, every pending card is an orphan', () => {
    expect(orphanApprovals(pending, []).map(x => x.requestId)).toEqual(['a', 'b'])
  })
})

describe('judge verdicts and Smart Approvals on cards (cycle 84)', () => {
  const judge = (over: Record<string, unknown> = {}) => ({
    rule: { floor: 'review', reasons: [] }, verdict: null, pending: true, autoPossible: true, ...over
  })
  const landed = judge({ pending: false, verdict: { risk: 'low', recommendation: 'approve', confidence: 0.95, reasons: ['fits the goal'], model: 'm', latencyMs: 1 } })
  const note = { decidedBy: 'judge', confidence: 0.95, reason: 'fits the goal' }

  it('an approval-verdict frame lands on its own card; the latest replaces the earlier', () => {
    let s: PendingApprovals = {}
    s = apply(s, frame('r1', 'A'))
    s = apply(s, frame('r2', 'B'))
    s = apply(s, { type: 'approval-verdict', requestId: 'r1', judge: judge() })
    expect(approvalFor(s, 'r1')?.judge).toMatchObject({ pending: true })
    expect(approvalFor(s, 'r2')?.judge).toBeUndefined()
    s = apply(s, { type: 'approval-verdict', requestId: 'r1', judge: landed })
    expect(approvalFor(s, 'r1')?.judge).toMatchObject({ pending: false, verdict: { recommendation: 'approve' } })
    expect(approvalFor(s, 'r1')?.command).toBe('A')
  })

  it('a verdict for a card this page never saw (or already resolved) is dropped — it never resurrects one', () => {
    const s0 = apply({}, frame('r1', 'A'))
    expect(apply(s0, { type: 'approval-verdict', requestId: 'nope', judge: landed })).toBe(s0)
    const resolved = apply(s0, { type: 'approval-resolved', requestId: 'r1', decidedBy: 'tony' })
    expect(apply(resolved, { type: 'approval-verdict', requestId: 'r1', judge: landed })).toEqual({})
  })

  it('a malformed verdict frame is ignored', () => {
    const s0 = apply({}, frame('r1', 'A'))
    for (const bad of [null, 'x', { pending: true }, { pending: true, autoPossible: true, rule: null, verdict: { reasons: 'no' } }, { pending: 'yes', autoPossible: true, rule: null, verdict: null }]) {
      expect(apply(s0, { type: 'approval-verdict', requestId: 'r1', judge: bad })).toBe(s0)
    }
  })

  it('resolved BY THE JUDGE: the card stays, flipped to auto-approved, with nothing left to approve or deny', () => {
    let s = apply({}, frame('r1', 'A'))
    s = apply(s, { type: 'approval-verdict', requestId: 'r1', judge: landed })
    s = apply(s, { type: 'approval-resolved', requestId: 'r1', decidedBy: 'judge', auto: note })
    const d = approvalFor(s, 'r1')
    expect(d?.auto).toEqual(note)
    expect(canApprove('gmail_send', d)).toBe(false)
    expect(canApprove('exec', d)).toBe(false)
    // a late verdict frame does not touch an auto-approved card
    expect(setApprovalVerdict(s, 'r1', judge() as never)).toBe(s)
    // and it is never re-raised as an orphan card
    expect(orphanApprovals(s, [])).toEqual([])
  })

  it('any other resolution removes the card — an `auto` note without decidedBy judge is not trusted', () => {
    const s0 = apply({}, frame('r1', 'A'))
    expect(apply(s0, { type: 'approval-resolved', requestId: 'r1', decidedBy: 'tony' })).toEqual({})
    expect(apply(s0, { type: 'approval-resolved', requestId: 'r1', decidedBy: 'timeout' })).toEqual({})
    expect(apply(s0, { type: 'approval-resolved', requestId: 'r1', decidedBy: 'tony', auto: note })).toEqual({})
    expect(apply(s0, { type: 'approval-resolved', requestId: 'r1', decidedBy: 'judge', auto: { ...note, decidedBy: 'tony' } })).toEqual({})
    expect(apply(s0, { type: 'approval-resolved', requestId: 'r1', decidedBy: 'judge', auto: { decidedBy: 'judge', confidence: '0.9', reason: null } })).toEqual({})
    expect(apply(s0, { type: 'approval-resolved', requestId: 'r1', decidedBy: 'judge' })).toEqual({})
    expect(resolveApproval(s0, 'r1', { ...note, decidedBy: 'tony' } as never)).toEqual({})
  })

  it('the frame mapper only passes a well-formed judge note on a judge resolution', () => {
    const fx = (m: unknown) => mapServerMessage(m as never, false, null)
    expect(fx({ type: 'approval-resolved', requestId: 'r1', decidedBy: 'judge', auto: note })).toEqual({ approvalResolved: 'r1', approvalAuto: note })
    expect(fx({ type: 'approval-resolved', requestId: 'r1', decidedBy: 'judge', auto: { ...note, decidedBy: 'tony' } })).toEqual({ approvalResolved: 'r1' })
    expect(fx({ type: 'approval-resolved', requestId: 'r1', decidedBy: 'tony', auto: note })).toEqual({ approvalResolved: 'r1' })
    expect(fx({ type: 'approval-resolved', requestId: 'r1', decidedBy: 'judge', auto: { ...note, reason: 5 } })).toEqual({ approvalResolved: 'r1' })
  })

  it('an auto resolution for an unknown card is a no-op', () => {
    const s0 = apply({}, frame('r1', 'A'))
    expect(resolveApproval(s0, 'nope', note as never)).toBe(s0)
  })
})
