import { describe, it, expect } from 'vitest'
import { chooseResolution, countEvidenceSessions } from './memory-resolve'

const v = (relation: string, confidence: number, existingId = 'x1') =>
  ({ relation, confidence, existingId, reasoning: 'r' }) as never

const base = {
  threshold: 0.8, scope: 'agent' as const, challengerSessions: 1, sessionsFor: () => 1
}
/** `sessionsFor` that returns the same corroboration count for any incumbent id. */
const incumbent = (n: number) => () => n

describe('chooseResolution — unchanged branches', () => {
  it('still prefers a duplicate above the dup floor', () => {
    expect(chooseResolution([v('duplicate', 0.9)], base).action).toBe('duplicate')
  })

  it('still supersedes on a confident refines', () => {
    expect(chooseResolution([v('refines', 0.9)], base).action).toBe('supersede')
  })

  it('still routes a low-confidence refines to review', () => {
    expect(chooseResolution([v('refines', 0.5)], base).action).toBe('review-supersede')
  })

  it('still inserts when nothing matches', () => {
    expect(chooseResolution([], base).action).toBe('insert')
  })
})

describe('chooseResolution — contradiction gate', () => {
  it('never silently resolves a user-scope contradiction', () => {
    const plan = chooseResolution([v('contradicts', 0.95)], { ...base, scope: 'user' })
    expect(plan.action).toBe('review-contradict')
    expect(plan.targetId).toBe('x1')
  })

  it('routes to review when the incumbent is better corroborated than the challenger', () => {
    expect(chooseResolution([v('contradicts', 0.95)],
      { ...base, sessionsFor: incumbent(5), challengerSessions: 1 }).action).toBe('review-contradict')
  })

  it('auto-resolves agent-scope when corroboration is equal', () => {
    expect(chooseResolution([v('contradicts', 0.95)],
      { ...base, sessionsFor: incumbent(1), challengerSessions: 1 }).action).toBe('contradict')
  })

  it('auto-resolves when the challenger is itself well corroborated', () => {
    expect(chooseResolution([v('contradicts', 0.95)],
      { ...base, sessionsFor: incumbent(3), challengerSessions: 3 }).action).toBe('contradict')
  })

  it('auto-resolves world-scope with an uncorroborated incumbent', () => {
    expect(chooseResolution([v('contradicts', 0.9)],
      { ...base, scope: 'world', sessionsFor: incumbent(1), challengerSessions: 1 }).action).toBe('contradict')
  })

  it('picks the highest-confidence contradiction as the target', () => {
    const plan = chooseResolution(
      [v('contradicts', 0.6, 'lo'), v('contradicts', 0.9, 'hi')], { ...base, scope: 'user' })
    expect(plan.targetId).toBe('hi')
  })

  it('auto-resolves when the incumbent has fewer than 2 corroborating sessions', () => {
    // Pins the >=2 floor: a lone-session incumbent is not "corroborated" and must not
    // route to review just because the challenger has even less (0) evidence.
    expect(chooseResolution([v('contradicts', 0.95)],
      { ...base, sessionsFor: incumbent(1), challengerSessions: 0 }).action).toBe('contradict')
  })

  it('routes to review at the minimal real trigger (2-vs-1)', () => {
    expect(chooseResolution([v('contradicts', 0.95)],
      { ...base, sessionsFor: incumbent(2), challengerSessions: 1 }).action).toBe('review-contradict')
  })

  it('does not let an agent-scope contradiction hijack a verdict set that should refine', () => {
    // Branch order matters: refines must still be checked before contradicts, even when
    // a contradiction verdict is also present in the same batch.
    const plan = chooseResolution(
      [v('refines', 0.9, 'r1'), v('contradicts', 0.95, 'c1')], base)
    expect(plan.action).toBe('supersede')
    expect(plan.targetId).toBe('r1')
  })

  it('does not let a user-scope contradiction hijack a verdict set that should refine', () => {
    // Same branch-order guarantee under user scope. The action is now gated to review
    // (user-scope never auto-archives), but the TARGET must still be the refines row —
    // the contradiction must not hijack the resolution.
    const plan = chooseResolution(
      [v('refines', 0.9, 'r1'), v('contradicts', 0.95, 'c1')], { ...base, scope: 'user' })
    expect(plan.action).toBe('review-supersede')
    expect(plan.action).not.toBe('review-contradict')
    expect(plan.targetId).toBe('r1')
  })
})

describe('chooseResolution — supersede gate (the branch that actually archives)', () => {
  it('never auto-supersedes a user-scope memory, even at near-certain confidence', () => {
    // `supersede` is the ONLY action that archives the incumbent. Scope beats confidence.
    const plan = chooseResolution([v('refines', 0.95)], { ...base, scope: 'user' })
    expect(plan.action).toBe('review-supersede')
    expect(plan.targetId).toBe('x1')
  })

  it('routes a confident agent-scope refines to review when the incumbent is better corroborated', () => {
    expect(chooseResolution([v('refines', 0.95)],
      { ...base, sessionsFor: incumbent(5), challengerSessions: 1 }).action).toBe('review-supersede')
  })

  it('still auto-supersedes agent-scope when corroboration is equal', () => {
    expect(chooseResolution([v('refines', 0.95)],
      { ...base, sessionsFor: incumbent(1), challengerSessions: 1 }).action).toBe('supersede')
  })

  it('resolves corroboration for the REFINES target, never the contradiction target', () => {
    // The refines verdict and the top contradiction routinely name DIFFERENT memories.
    // Gating the refines branch on the contradiction's corroboration would be a silent
    // mis-gate, so pin the exact id the lookup is asked about.
    const asked: string[] = []
    const plan = chooseResolution(
      [v('refines', 0.95, 'r1'), v('contradicts', 0.99, 'c1')],
      { ...base, sessionsFor: (id) => { asked.push(id); return 1 } })
    expect(plan.targetId).toBe('r1')
    expect(asked).toEqual(['r1'])
    expect(asked).not.toContain('c1')
  })
})

describe('countEvidenceSessions', () => {
  it('counts distinct sessionIds', () => {
    expect(countEvidenceSessions([{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'a' }])).toBe(2)
  })
  it('ignores entries with a null or missing sessionId', () => {
    expect(countEvidenceSessions([{ sessionId: null }, {}, { sessionId: 'a' }])).toBe(1)
  })
  it('returns 0 for an empty array', () => {
    expect(countEvidenceSessions([])).toBe(0)
  })
  it('tolerates non-object entries without throwing', () => {
    expect(countEvidenceSessions(['nope', 42, null])).toBe(0)
  })
  it('returns 0 for non-array jsonb without throwing', () => {
    expect(countEvidenceSessions({} as never)).toBe(0)
    expect(countEvidenceSessions(null as never)).toBe(0)
    expect(countEvidenceSessions(undefined as never)).toBe(0)
  })
})
