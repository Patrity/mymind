import { describe, expect, it } from 'vitest'
import type { ApprovalVerdictDTO } from '@mymind/core/lib/agent/judge/types'
import {
  autoApprovalNote, autoApprovedLabel, floorShown, formatConfidence, guardSourceLabel, judgeConfidenceError,
  outputWarningFor, recommendationColor, riskColor, verdictView
} from './judge-display'

const verdict = (over: Partial<NonNullable<ApprovalVerdictDTO['verdict']>> = {}): NonNullable<ApprovalVerdictDTO['verdict']> => ({
  risk: 'low', recommendation: 'approve', confidence: 0.94, reasons: ['matches the goal'], model: 'm', latencyMs: 900, ...over
})
const dto = (over: Partial<ApprovalVerdictDTO> = {}): ApprovalVerdictDTO => ({
  rule: { floor: 'review', reasons: [] }, verdict: null, pending: true, autoPossible: true, ...over
})

describe('risk and recommendation colours (semantic Nuxt UI tokens)', () => {
  it('maps every risk', () => {
    expect(riskColor('low')).toBe('success')
    expect(riskColor('medium')).toBe('warning')
    expect(riskColor('high')).toBe('error')
    expect(riskColor('critical')).toBe('error')
    expect(riskColor(null)).toBe('neutral')
    expect(riskColor(undefined)).toBe('neutral')
  })
  it('maps every recommendation', () => {
    expect(recommendationColor('approve')).toBe('success')
    expect(recommendationColor('review')).toBe('warning')
    expect(recommendationColor('deny')).toBe('error')
  })
})

describe('formatConfidence', () => {
  it('two decimals, clamped, NaN → 0.00', () => {
    expect(formatConfidence(0.94)).toBe('0.94')
    expect(formatConfidence(0.9)).toBe('0.90')
    expect(formatConfidence(1.7)).toBe('1.00')
    expect(formatConfidence(-1)).toBe('0.00')
    expect(formatConfidence(Number.NaN)).toBe('0.00')
  })
})

describe('verdictView', () => {
  it('nothing without a judge', () => {
    expect(verdictView(null)).toBeNull()
    expect(verdictView(undefined)).toBeNull()
  })
  it('pending → spinner state, carrying whether Smart Approvals may still run it', () => {
    expect(verdictView(dto())).toEqual({ kind: 'pending', autoPossible: true, rule: null })
    expect(verdictView(dto({ autoPossible: false }))).toMatchObject({ kind: 'pending', autoPossible: false })
  })
  it('no verdict and not pending → nothing to show', () => {
    expect(verdictView(dto({ pending: false }))).toBeNull()
  })
  it('a landed verdict shows risk, recommendation, confidence and reasons', () => {
    expect(verdictView(dto({ pending: false, verdict: verdict() }))).toEqual({
      kind: 'verdict', risk: 'low', riskColor: 'success', recommendation: 'approve', recommendationColor: 'success',
      confidence: '0.94', reasons: ['matches the goal'], rule: null
    })
  })
  it('a verdict wins over a stale pending flag', () => {
    expect(verdictView(dto({ pending: true, verdict: verdict({ risk: 'high', recommendation: 'deny' }) })))
      .toMatchObject({ kind: 'verdict', riskColor: 'error', recommendationColor: 'error' })
  })
  it('an error verdict is "no verdict", never an approval', () => {
    const v = verdictView(dto({ pending: false, verdict: verdict({ error: 'judge timed out', risk: null, recommendation: 'review', confidence: 0 }) }))
    expect(v).toEqual({ kind: 'error', error: 'judge timed out', rule: null })
  })
  it('shows the rule floor only when it puts the call on Tony', () => {
    expect(floorShown('low')).toBe(false)
    expect(floorShown('review')).toBe(false)
    expect(floorShown('high')).toBe(true)
    expect(floorShown('critical')).toBe(true)
    expect(floorShown('deny')).toBe(true)
    expect(floorShown(undefined)).toBe(false)
    const high = dto({ rule: { floor: 'high', reasons: ['host exec always needs Tony'] }, autoPossible: false })
    expect(verdictView(high)).toEqual({ kind: 'pending', autoPossible: false, rule: { floor: 'high', reasons: ['host exec always needs Tony'] } })
    expect(verdictView({ ...high, pending: false, verdict: verdict() })).toMatchObject({ kind: 'verdict', rule: { floor: 'high' } })
    expect(verdictView({ ...high, pending: false, verdict: verdict({ error: 'x' }) })).toMatchObject({ kind: 'error', rule: { floor: 'high' } })
  })
  it('passes reasons through as data — markup stays text for {{ }} to escape', () => {
    const v = verdictView(dto({ pending: false, verdict: verdict({ reasons: ['<img src=x onerror=alert(1)>', '**bold**'] }) }))
    expect(v).toMatchObject({ reasons: ['<img src=x onerror=alert(1)>', '**bold**'] })
  })
})

describe('auto-approval labels', () => {
  it('the card label', () => {
    expect(autoApprovedLabel({ confidence: 0.94 })).toBe('⚖ auto-approved (0.94)')
  })
  it('the thread note carries the first reason, collapsed to one line', () => {
    expect(autoApprovalNote({ decidedBy: 'judge', confidence: 0.94, reason: 'RSVP  matches\nthe goal' }))
      .toBe('⚖ auto-approved (0.94): RSVP matches the goal')
  })
  it('no reason → just the label', () => {
    expect(autoApprovalNote({ decidedBy: 'judge', confidence: 0.95, reason: null })).toBe('⚖ auto-approved (0.95)')
    expect(autoApprovalNote({ decidedBy: 'judge', confidence: 0.95, reason: '   ' })).toBe('⚖ auto-approved (0.95)')
  })
  it('only a judge decision is an auto-approval', () => {
    expect(autoApprovalNote(null)).toBeNull()
    expect(autoApprovalNote(undefined)).toBeNull()
    expect(autoApprovalNote({ decidedBy: 'tony', confidence: 1, reason: 'x' } as never)).toBeNull()
  })
})

describe('outputWarningFor', () => {
  const w = { toolCallId: 'c1', source: 'web' as const, reasons: ['instruction override'], score: 9 }
  const m = { parts: [
    { type: 'dynamic-tool', toolCallId: 'c1' },
    { type: 'data-output_warning', id: 'c2', data: { ...w, toolCallId: 'c2' } },
    { type: 'data-output_warning', id: 'c1', data: w }
  ] } as never
  it('finds the warning keyed by its own call only', () => {
    expect(outputWarningFor(m, 'c1')).toBe(w)
    expect(outputWarningFor(m, 'c2')).toMatchObject({ toolCallId: 'c2' })
    expect(outputWarningFor(m, 'c3')).toBeNull()
  })
  it('labels sources', () => {
    expect(guardSourceLabel('web')).toBe('web content')
    expect(guardSourceLabel('child')).toBe('a child workstream')
  })
})

describe('judgeConfidenceError (0.5–0.99)', () => {
  it('accepts the bounds and between', () => {
    for (const v of [0.5, 0.99, 0.9, '0.75', ' 0.5 ']) expect(judgeConfidenceError(v)).toBeNull()
  })
  it('rejects out of range', () => {
    for (const v of [0.49, 1, 0, -0.5, '0.3', '1.5']) expect(judgeConfidenceError(v)).toBe('Must be between 0.5 and 0.99')
  })
  it('rejects non-numbers', () => {
    for (const v of ['', 'abc', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(judgeConfidenceError(v)).toBe('Enter a number')
  })
})
