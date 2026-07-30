import { describe, it, expect } from 'vitest'
import { chooseResolution } from '../server/services/memory-resolve'
import type { Verdict } from '../server/lib/ai/memory-judge'
const v = (existingId: string, relation: Verdict['relation'], confidence: number): Verdict => ({ existingId, relation, confidence })

describe('chooseResolution', () => {
  it('duplicate (>=0.6) wins → merge', () => {
    expect(chooseResolution([v('a','duplicate',0.9), v('b','refines',0.95)], { threshold: 0.75, scope: 'agent', incumbentSessions: 1, challengerSessions: 1 })).toMatchObject({ action: 'duplicate', targetId: 'a' })
  })
  it('high-confidence refines → auto supersede', () => {
    expect(chooseResolution([v('a','refines',0.9)], { threshold: 0.75, scope: 'agent', incumbentSessions: 1, challengerSessions: 1 })).toMatchObject({ action: 'supersede', targetId: 'a' })
  })
  it('low-confidence refines → review-supersede', () => {
    expect(chooseResolution([v('a','refines',0.5)], { threshold: 0.75, scope: 'agent', incumbentSessions: 1, challengerSessions: 1 })).toMatchObject({ action: 'review-supersede', targetId: 'a' })
  })
  it('contradicts → contradict', () => {
    expect(chooseResolution([v('a','contradicts',0.8)], { threshold: 0.75, scope: 'agent', incumbentSessions: 1, challengerSessions: 1 })).toMatchObject({ action: 'contradict', targetId: 'a' })
  })
  it('all unrelated → insert', () => {
    expect(chooseResolution([v('a','unrelated',0.9)], { threshold: 0.75, scope: 'agent', incumbentSessions: 1, challengerSessions: 1 })).toMatchObject({ action: 'insert' })
  })
  it('empty → insert', () => {
    expect(chooseResolution([], { threshold: 0.75, scope: 'agent', incumbentSessions: 1, challengerSessions: 1 })).toMatchObject({ action: 'insert' })
  })
})
