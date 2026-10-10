import { describe, it, expect } from 'vitest'
import { reviewGateDecision, type GateRow } from './review-gate'
import { AUDIT_PROMPT_VERSION } from '@mymind/core/lib/memory/extract-v3'

const OPTS = { jevConfigured: true, maxFailures: 3 }
const pending: GateRow = { jevScoredAt: null, jevAnswers: null, jevFailures: 0, auditPromptVersion: null, auditVerdict: null, auditFailures: 0 }
const jev = (transient: number): Partial<GateRow> => ({ jevScoredAt: new Date(), jevAnswers: { transient } })
const audit = (verdict: string): Partial<GateRow> => ({ auditPromptVersion: AUDIT_PROMPT_VERSION, auditVerdict: verdict })
const decide = (...parts: Partial<GateRow>[]) => reviewGateDecision(Object.assign({}, pending, ...parts), OPTS)

describe('reviewGateDecision', () => {
  it('holds only when both scorers flag', () => {
    expect(decide(jev(0.6), audit('transient'))).toBe('hold')
    expect(decide(jev(0.9), audit('redundant'))).toBe('hold')
    expect(decide(jev(0.9), audit('wrong_scope'))).toBe('hold')
  })

  it('passes when either scorer keeps it', () => {
    expect(decide(jev(0.59), audit('transient'))).toBe('pass')
    expect(decide(jev(0.9), audit('keep'))).toBe('pass')
  })

  it('never holds on belongs_in_doc — that is routing, not staleness', () => {
    expect(decide(jev(0.9), audit('belongs_in_doc'))).toBe('pass')
  })

  it('passes early once one settled part does not flag', () => {
    expect(decide(jev(0.2))).toBe('pass')
    expect(decide(audit('keep'))).toBe('pass')
  })

  it('waits while a flagged part awaits the other', () => {
    expect(decide()).toBe('wait')
    expect(decide(jev(0.8))).toBe('wait')
    expect(decide(audit('transient'))).toBe('wait')
  })

  it('treats a stale audit prompt version as not yet audited', () => {
    expect(decide(jev(0.8), { auditPromptVersion: 'audit-v1', auditVerdict: 'transient' })).toBe('wait')
  })

  it('passes when a part is permanently missing (cap reached, or Jev off)', () => {
    expect(decide(audit('transient'), { jevFailures: 3 })).toBe('pass')
    expect(decide(jev(0.9), { auditFailures: 3 })).toBe('pass')
    expect(reviewGateDecision({ ...pending, ...audit('transient') } as GateRow, { ...OPTS, jevConfigured: false })).toBe('pass')
  })

  it('passes a Jev stamp without a transient answer (partial response)', () => {
    expect(decide({ jevScoredAt: new Date(), jevAnswers: { rederivable: 0.9 } }, audit('transient'))).toBe('pass')
  })
})
