import { describe, it, expect } from 'vitest'
import { fitBudget, tier, ResidentOverflowError, TURN_FLOOR_RATIO } from '../server/lib/agent/budget'

// estimateTokens is chars/3.8 rounded up, so 38 chars ≈ 10 tokens.
const chars = (n: number) => 'x'.repeat(n)
const t = (name: string, n: number) => tier(name, chars(n))

describe('fitBudget', () => {
  it('keeps everything when it all fits', () => {
    const r = fitBudget({ fixed: [t('resident', 38)], turns: [t('turn', 38)], retrieved: [t('mem', 38)], budget: 1000 })
    expect(r.kept.fixed).toHaveLength(1)
    expect(r.kept.turns).toHaveLength(1)
    expect(r.kept.retrieved).toHaveLength(1)
    expect(r.droppedTurns).toBe(0)
    expect(r.droppedRetrieved).toBe(0)
  })

  it('evicts retrieved memories before turns', () => {
    const r = fitBudget({
      fixed: [t('resident', 38)],                       // 10
      turns: [t('turn1', 38), t('turn2', 38)],          // 10 + 10
      retrieved: [t('m1', 38), t('m2', 38)],            // 10 + 10
      budget: 40
    })
    expect(r.kept.turns).toHaveLength(2)
    expect(r.droppedRetrieved).toBeGreaterThan(0)
    expect(r.droppedTurns).toBe(0)
  })

  it('never evicts a fixed tier', () => {
    const r = fitBudget({ fixed: [t('resident', 380)], turns: [], retrieved: [t('m', 380)], budget: 110 })
    expect(r.kept.fixed).toHaveLength(1)
    expect(r.kept.retrieved).toHaveLength(0)
  })

  it('reserves a floor for turns that retrieval cannot eat', () => {
    // budget 100 -> turn floor is 40 tokens. Retrieval must not push turns below it.
    const r = fitBudget({
      fixed: [],
      turns: [t('turn1', 76), t('turn2', 76)],   // 20 + 20 = 40, exactly the floor
      retrieved: Array.from({ length: 20 }, (_, i) => t(`m${i}`, 380)),
      budget: 100
    })
    const turnTokens = r.kept.turns.reduce((a, x) => a + x.tokens, 0)
    expect(turnTokens).toBeGreaterThanOrEqual(Math.floor(100 * TURN_FLOOR_RATIO))
  })

  it('keeps the MOST RECENT turns when turns must be trimmed', () => {
    // turns arrive oldest-first; trimming drops from the front.
    const r = fitBudget({
      fixed: [],
      turns: [tier('old', chars(380)), tier('mid', chars(380)), tier('new', chars(380))],
      turnFloorRatio: 1,
      retrieved: [],
      budget: 200
    })
    expect(r.kept.turns.map(x => x.name)).toEqual(['mid', 'new'])
    expect(r.droppedTurns).toBe(1)
  })

  it('throws when the fixed tiers alone exceed the budget', () => {
    expect(() => fitBudget({ fixed: [t('resident', 3800)], turns: [], retrieved: [], budget: 100 }))
      .toThrow(ResidentOverflowError)
  })

  it('reports used tokens as the sum of what it kept', () => {
    const r = fitBudget({ fixed: [t('a', 38)], turns: [t('b', 38)], retrieved: [t('c', 38)], budget: 1000 })
    const sum = [...r.kept.fixed, ...r.kept.turns, ...r.kept.retrieved].reduce((a, x) => a + x.tokens, 0)
    expect(r.used).toBe(sum)
  })
})
