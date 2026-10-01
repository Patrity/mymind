import { describe, it, expect } from 'vitest'
import { DISAGREE_THRESHOLD } from '~~/shared/types/memory'
import {
  scoreColor, jevTooltip, auditTooltip, disagreement, isDisagreement,
  VERDICT_LABELS, verdictColor
} from './scores'

describe('scoreColor — the /review bands', () => {
  it('null is dimmed (not scored yet)', () => {
    expect(scoreColor(null)).toBe('text-dimmed')
    expect(scoreColor(undefined)).toBe('text-dimmed')
  })
  it('< 0.4 warning, < 0.6 muted, else success', () => {
    expect(scoreColor(0)).toBe('text-warning')
    expect(scoreColor(0.39)).toBe('text-warning')
    expect(scoreColor(0.4)).toBe('text-muted')
    expect(scoreColor(0.59)).toBe('text-muted')
    expect(scoreColor(0.6)).toBe('text-success')
    expect(scoreColor(1)).toBe('text-success')
  })
})

describe('jevTooltip', () => {
  it('says not scored yet for null', () => {
    expect(jevTooltip(null)).toBe('Not scored yet')
  })
  it('keeps the /review wording and percent', () => {
    expect(jevTooltip(0.72)).toBe('Jev\'s independent read: 72% — specific and durable. Advisory; it orders, it does not decide.')
    expect(jevTooltip(0.2)).toContain('likely transient or easily re-derived')
    expect(jevTooltip(0.5)).toContain('mixed')
  })
  it('appends the raw answers when given', () => {
    const t = jevTooltip(0.5, { transient: 0.76, rederivable: 0.3 })
    expect(t).toContain('transient 76%')
    expect(t).toContain('rederivable 30%')
  })
})

describe('auditTooltip', () => {
  it('says not audited yet for null', () => {
    expect(auditTooltip(null, null, null)).toBe('Not audited yet')
  })
  it('carries percent, verdict label and reason', () => {
    const t = auditTooltip(0.81, 'belongs_in_doc', 'Detail of one system; better in its wiki.')
    expect(t).toContain('81%')
    expect(t).toContain(VERDICT_LABELS.belongs_in_doc)
    expect(t).toContain('Detail of one system; better in its wiki.')
    expect(t).not.toContain('..')
  })
})

describe('verdictColor', () => {
  it('keep is success, everything else warning, missing neutral', () => {
    expect(verdictColor('keep')).toBe('success')
    expect(verdictColor('transient')).toBe('warning')
    expect(verdictColor('redundant')).toBe('warning')
    expect(verdictColor('wrong_scope')).toBe('warning')
    expect(verdictColor('belongs_in_doc')).toBe('warning')
    expect(verdictColor(null)).toBe('neutral')
  })
})

describe('disagreement', () => {
  it('is |a - b|', () => {
    expect(disagreement(0.9, 0.2)).toBeCloseTo(0.7, 10)
    expect(disagreement(0.2, 0.9)).toBeCloseTo(0.7, 10)
    expect(disagreement(0.5, 0.5)).toBe(0)
  })
  it('is null when either side is null — never 0 (Review Focus 5)', () => {
    expect(disagreement(null, 0.9)).toBeNull()
    expect(disagreement(0.9, null)).toBeNull()
    expect(disagreement(null, null)).toBeNull()
    expect(disagreement(undefined, 0.1)).toBeNull()
  })
  it('lands exactly on the threshold despite float error (0.7 - 0.3)', () => {
    expect(disagreement(0.7, 0.3)).toBe(0.4)
  })
})

describe('isDisagreement', () => {
  it('threshold is 0.4', () => {
    expect(DISAGREE_THRESHOLD).toBe(0.4)
  })
  it('>= 0.4 with both scores present', () => {
    expect(isDisagreement(0.7, 0.3)).toBe(true)
    expect(isDisagreement(0.9, 0.1)).toBe(true)
    expect(isDisagreement(0.6, 0.3)).toBe(false)
  })
  it('a single score is never a disagreement', () => {
    expect(isDisagreement(0.95, null)).toBe(false)
    expect(isDisagreement(null, 0.05)).toBe(false)
  })
})
