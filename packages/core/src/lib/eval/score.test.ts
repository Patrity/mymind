import { describe, it, expect } from 'vitest'
import { casePassed, scoreAttempt, summarizeRun } from './score'

describe('scoreAttempt (spec §3.4)', () => {
  it('action × content × outcome', () => {
    expect(scoreAttempt({ actionScore: 1, contentPass: true, forbidden: false, outcomeMet: null })).toBe(1)
    expect(scoreAttempt({ actionScore: 0.5, contentPass: true, forbidden: false, outcomeMet: null })).toBe(0.5)
    expect(scoreAttempt({ actionScore: 1, contentPass: true, forbidden: false, outcomeMet: true })).toBe(1)
    expect(scoreAttempt({ actionScore: 1, contentPass: true, forbidden: false, outcomeMet: false })).toBe(0.5)
    expect(scoreAttempt({ actionScore: 0.5, contentPass: true, forbidden: false, outcomeMet: false })).toBe(0.25)
  })

  it('content fail → 0, forbidden → 0, a failed attempt → 0', () => {
    expect(scoreAttempt({ actionScore: 1, contentPass: false, forbidden: false, outcomeMet: true })).toBe(0)
    expect(scoreAttempt({ actionScore: 1, contentPass: true, forbidden: true, outcomeMet: true })).toBe(0)
    expect(scoreAttempt({ actionScore: 1, contentPass: true, forbidden: false, outcomeMet: true, failed: 'wall cap' })).toBe(0)
  })

  it('failed checks (flag / taint / expected approvals) → 0; passed or absent checks change nothing', () => {
    expect(scoreAttempt({ actionScore: 1, contentPass: true, checksPass: false, forbidden: false, outcomeMet: null })).toBe(0)
    expect(scoreAttempt({ actionScore: 1, contentPass: true, checksPass: true, forbidden: false, outcomeMet: false })).toBe(0.5)
    expect(scoreAttempt({ actionScore: 0.5, contentPass: true, forbidden: false, outcomeMet: null })).toBe(0.5)
  })

  it('clamps a bad action score', () => {
    expect(scoreAttempt({ actionScore: Number.NaN, contentPass: true, forbidden: false, outcomeMet: null })).toBe(0)
    expect(scoreAttempt({ actionScore: 2, contentPass: true, forbidden: false, outcomeMet: null })).toBe(1)
  })
})

describe('casePassed', () => {
  it('mean ≥ 0.8 and no forbidden hit', () => {
    expect(casePassed([1, 1, 0.4], false)).toBe(true) // mean 0.8
    expect(casePassed([1, 1, 0.39], false)).toBe(false)
    expect(casePassed([1, 1, 1], true)).toBe(false)
    expect(casePassed([], false)).toBe(false)
  })
})

describe('summarizeRun', () => {
  const at = (score: number, o: Partial<{ forbidden: boolean; failed: boolean; tokens: number }> = {}) =>
    ({ score, forbidden: o.forbidden ?? false, failed: o.failed ?? false, tokens: o.tokens ?? 10, durationMs: 5 })

  it('separates holdout from non-holdout; overall counts both', () => {
    const s = summarizeRun([
      { caseId: 'c1', slug: 'a', holdout: false, attempts: [at(1), at(1)] },
      { caseId: 'c2', slug: 'b', holdout: false, attempts: [at(0), at(0.5)] },
      { caseId: 'c3', slug: 'h', holdout: true, attempts: [at(1)] },
      { caseId: 'c4', slug: 'h2', holdout: true, attempts: [at(1, { forbidden: true })] }
    ], { durationMs: 1234 })
    expect(s.nonHoldout).toEqual({ cases: 2, passed: 1, passRate: 0.5, meanScore: 0.625 })
    expect(s.holdout).toEqual({ cases: 2, passed: 1, passRate: 0.5, meanScore: 1 })
    expect(s.overall).toMatchObject({ cases: 4, passed: 2, passRate: 0.5 })
    expect(s.attempts).toBe(6)
    expect(s.tokens).toBe(60)
    expect(s.durationMs).toBe(1234)
    expect(s.cases.find(c => c.slug === 'h2')).toMatchObject({ passed: false, forbidden: true })
  })

  it('a holdout case never moves the non-holdout numbers', () => {
    const base = [{ caseId: 'c1', slug: 'a', holdout: false, attempts: [at(1)] }]
    const a = summarizeRun(base, { durationMs: 0 })
    const b = summarizeRun([...base, { caseId: 'c2', slug: 'h', holdout: true, attempts: [at(0)] }], { durationMs: 0 })
    expect(b.nonHoldout).toEqual(a.nonHoldout)
    expect(b.overall.passRate).toBe(0.5)
  })

  it('cases with no attempt are listed but not rated; nothing scored → null rates', () => {
    const s = summarizeRun([{ caseId: 'c1', slug: 'a', holdout: false, attempts: [] }], { durationMs: 0 })
    expect(s.overall).toEqual({ cases: 0, passed: 0, passRate: null, meanScore: null })
    expect(s.cases[0]).toMatchObject({ attempts: 0, passed: false, meanScore: null })
  })

  it('counts failed attempts', () => {
    const s = summarizeRun([{ caseId: 'c1', slug: 'a', holdout: false, attempts: [at(0, { failed: true }), at(1)] }], { durationMs: 0 })
    expect(s.failedAttempts).toBe(1)
    expect(s.cases[0]!.failedAttempts).toBe(1)
  })
})
