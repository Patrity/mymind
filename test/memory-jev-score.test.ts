import { describe, it, expect } from 'vitest'
import { jevKeepScore, compareByJev, JEV_QUESTIONS, type JevAnswers } from '../server/lib/memory/jev-score'

const A = (over: Partial<JevAnswers> = {}): JevAnswers => ({
  transient: 0.5, rederivable: 0.5, names_specific: 0.5, states_reason: 0.5, ...over
})

describe('jevKeepScore', () => {
  it('reads the SAME WAY as confidence — higher means more likely worth keeping', () => {
    // The orientation is the whole point of showing it beside confidence: a reader must not
    // have to remember that one of the two numbers points the other way.
    const keeper = jevKeepScore(A({ transient: 0.05, rederivable: 0.1, names_specific: 0.95, states_reason: 0.9 }))!
    const junk = jevKeepScore(A({ transient: 0.95, rederivable: 0.9, names_specific: 0.05, states_reason: 0.1 }))!
    expect(keeper).toBeGreaterThan(junk)
    expect(keeper).toBeGreaterThan(0.8)
    expect(junk).toBeLessThan(0.2)
  })

  it('lets `transient` dominate — it is the only signal with a significant CI', () => {
    // Flipping transient alone must outweigh all three weak signals pulling the other way,
    // or the ordering is driven by facets the calibration could not distinguish from noise.
    const transientButOtherwiseIdeal = jevKeepScore(A({ transient: 1, rederivable: 0, names_specific: 1, states_reason: 1 }))!
    const durableButOtherwisePoor = jevKeepScore(A({ transient: 0, rederivable: 1, names_specific: 0, states_reason: 0 }))!
    expect(durableButOtherwisePoor).toBeGreaterThan(transientButOtherwiseIdeal)
  })

  it('is monotonic in transient, holding everything else fixed', () => {
    const scores = [0, 0.25, 0.5, 0.75, 1].map(t => jevKeepScore(A({ transient: t }))!)
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThan(scores[i - 1]!)
  })

  it('always returns a value inside [0,1], even for out-of-range answers', () => {
    const s = jevKeepScore(A({ transient: -3, rederivable: 9, names_specific: 4, states_reason: -1 }))!
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(1)
  })

  it('returns null for a missing or partial answer set rather than scoring it as zero', () => {
    // An absent signal is not a bad signal — a memory with no score must sort as UNKNOWN,
    // and scoring a partial response would quietly rank it as junk.
    expect(jevKeepScore(null)).toBeNull()
    expect(jevKeepScore(undefined)).toBeNull()
    expect(jevKeepScore({})).toBeNull()
    expect(jevKeepScore({ transient: 0.5 })).toBeNull()
    expect(jevKeepScore({ ...A(), transient: Number.NaN })).toBeNull()
  })

  it('asks only OBSERVABLE questions — never "how valuable is this"', () => {
    // The taste question measured AUC 0.27 for noise (anti-correlated). Re-adding it is the
    // regression this guards: it asks Jev to guess Tony's judgement instead of read the text.
    const text = JSON.stringify(JEV_QUESTIONS).toLowerCase()
    expect(text).not.toContain('valuable')
    expect(text).not.toContain('worth keeping')
    expect(Object.keys(JEV_QUESTIONS).sort()).toEqual(
      ['names_specific', 'rederivable', 'states_reason', 'transient']
    )
    for (const q of Object.values(JEV_QUESTIONS)) expect(q.type).toBe('noul')
  })
})

describe('compareByJev', () => {
  const at = (iso: string) => new Date(iso)
  const row = (jevScore: number | null, iso: string) => ({ jevScore, createdAt: at(iso) })

  it('puts the WORST score first, so the junk is what you see', () => {
    const sorted = [row(0.9, '2026-01-01'), row(0.1, '2026-01-01'), row(0.5, '2026-01-01')]
      .sort(compareByJev)
      .map(r => r.jevScore)
    expect(sorted).toEqual([0.1, 0.5, 0.9])
  })

  it('sorts UNSCORED memories after every scored one — unknown is not bad', () => {
    // Putting nulls first would bury the thing this ordering exists to surface.
    const sorted = [row(null, '2026-01-03'), row(0.9, '2026-01-01'), row(null, '2026-01-02')]
      .sort(compareByJev)
      .map(r => r.jevScore)
    expect(sorted).toEqual([0.9, null, null])
  })

  it('falls back to newest-first on a tie, which is the order the queue had before', () => {
    const sorted = [row(0.5, '2026-01-01'), row(0.5, '2026-01-03'), row(0.5, '2026-01-02')]
      .sort(compareByJev)
      .map(r => r.createdAt.toISOString().slice(0, 10))
    expect(sorted).toEqual(['2026-01-03', '2026-01-02', '2026-01-01'])
  })

  it('orders the unscored block newest-first too', () => {
    const sorted = [row(null, '2026-01-01'), row(null, '2026-01-03'), row(null, '2026-01-02')]
      .sort(compareByJev)
      .map(r => r.createdAt.toISOString().slice(0, 10))
    expect(sorted).toEqual(['2026-01-03', '2026-01-02', '2026-01-01'])
  })
})
