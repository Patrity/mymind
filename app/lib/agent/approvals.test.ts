import { describe, expect, it } from 'vitest'
import { addApproval, approvalFor, canApprove, removeApproval, type PendingApprovals } from './approvals'
import { mapServerMessage } from '../voice/messages'

const frame = (requestId: string, command: string) =>
  ({ type: 'approval', requestId, tool: 'gmail_send', title: 'Send this email?', command, proposedPattern: '', allowlistable: false }) as never

/** The exact fold useVoice applies to incoming frames. */
function apply(state: PendingApprovals, m: unknown): PendingApprovals {
  const fx = mapServerMessage(m as never, false, null)
  if (fx.approval) state = addApproval(state, fx.approval)
  if (fx.approvalResolved) state = removeApproval(state, fx.approvalResolved)
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
