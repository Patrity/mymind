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
      retrieved: [t('m1', 380), t('m2', 380)],          // 100 + 100 (much larger)
      budget: 150
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

  it('shares budget when retrieval and turns both want space', () => {
    // Probe scenario: fixed 100, 40 turns of 100 each (4000 total), 10 retrieved of 100 each (1000 total), budget 1000.
    // With turnFloor = 400, turnCeiling = max(400, 900-1000) = 400, so turns get 400 (4 kept), retrieval gets 500 (5 kept).
    const r = fitBudget({
      fixed: [t('resident', 380)],                                               // 100 tokens
      turns: Array.from({ length: 40 }, (_, i) => t(`turn${i}`, 380)),         // 40 × 100 = 4000 tokens
      retrieved: Array.from({ length: 10 }, (_, i) => t(`m${i}`, 380)),        // 10 × 100 = 1000 tokens
      budget: 1000
    })
    const turnTokens = r.kept.turns.reduce((a, x) => a + x.tokens, 0)
    expect(r.kept.retrieved.length).toBeGreaterThan(0)
    expect(turnTokens).toBeGreaterThanOrEqual(Math.floor(1000 * TURN_FLOOR_RATIO))
  })

  it('turns exceed the floor when retrieval has little to say', () => {
    // Few retrieved items, many turns, enough budget: turns should grow above the floor.
    const r = fitBudget({
      fixed: [],
      turns: Array.from({ length: 40 }, (_, i) => t(`turn${i}`, 380)),         // 40 × 100
      retrieved: [t('m1', 380)],                                                // 1 × 100
      budget: 2000
    })
    const turnTokens = r.kept.turns.reduce((a, x) => a + x.tokens, 0)
    const turnFloor = Math.floor(2000 * TURN_FLOOR_RATIO)
    expect(turnTokens).toBeGreaterThan(turnFloor * 1.5)
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
