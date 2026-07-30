import { describe, it, expect } from 'vitest'
import { chooseResolution } from '../server/services/memory-resolve'
import type { Verdict } from '../server/lib/ai/memory-judge'
const v = (existingId: string, relation: Verdict['relation'], confidence: number): Verdict => ({ existingId, relation, confidence })
const opts = { threshold: 0.75, scope: 'agent' as const, challengerSessions: 1, sessionsFor: () => 1 }

describe('chooseResolution', () => {
  it('duplicate (>=0.6) wins → merge', () => {
    expect(chooseResolution([v('a','duplicate',0.9), v('b','refines',0.95)], opts)).toMatchObject({ action: 'duplicate', targetId: 'a' })
  })
  it('high-confidence refines → auto supersede', () => {
    expect(chooseResolution([v('a','refines',0.9)], opts)).toMatchObject({ action: 'supersede', targetId: 'a' })
  })
  it('low-confidence refines → review-supersede', () => {
    expect(chooseResolution([v('a','refines',0.5)], opts)).toMatchObject({ action: 'review-supersede', targetId: 'a' })
  })
  it('contradicts → contradict', () => {
    expect(chooseResolution([v('a','contradicts',0.8)], opts)).toMatchObject({ action: 'contradict', targetId: 'a' })
  })
  it('all unrelated → insert', () => {
    expect(chooseResolution([v('a','unrelated',0.9)], opts)).toMatchObject({ action: 'insert' })
  })
  it('empty → insert', () => {
    expect(chooseResolution([], opts)).toMatchObject({ action: 'insert' })
  })
})

describe('chooseResolution — corroboration gate on the archiving branch', () => {
  it('user-scope refines at 0.95 → review-supersede (gate beats confidence)', () => {
    expect(chooseResolution([v('a','refines',0.95)], { ...opts, scope: 'user' }))
      .toMatchObject({ action: 'review-supersede', targetId: 'a' })
  })
  it('out-corroborated agent-scope refines at 0.95 → review-supersede', () => {
    expect(chooseResolution([v('a','refines',0.95)], { ...opts, sessionsFor: () => 5, challengerSessions: 1 }))
      .toMatchObject({ action: 'review-supersede', targetId: 'a' })
  })
  it('equal corroboration at 0.95 → supersede (today’s behaviour preserved)', () => {
    expect(chooseResolution([v('a','refines',0.95)], { ...opts, sessionsFor: () => 1, challengerSessions: 1 }))
      .toMatchObject({ action: 'supersede', targetId: 'a' })
  })
  it('asks sessionsFor about the refines target, not the contradiction', () => {
    const asked: string[] = []
    const plan = chooseResolution([v('r1','refines',0.95), v('c1','contradicts',0.99)],
      { ...opts, sessionsFor: (id) => { asked.push(id); return 1 } })
    expect(plan).toMatchObject({ action: 'supersede', targetId: 'r1' })
    expect(asked).toEqual(['r1'])
  })
})
