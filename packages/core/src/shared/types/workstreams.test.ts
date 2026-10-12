// Cycle 83 Task 3 fix round 1 (I2): the tree budget formula — the ONE copy the core's spawn/resume
// checks and the UI's tree meter both use.
import { describe, it, expect } from 'vitest'
import { committedOf, normalizeTreeBudget, reservationOf, treeRemaining, type TreeMember } from './workstreams'

const m = (state: TreeMember['state'], budget: [number, number], used: [number, number]): TreeMember =>
  ({ state, budget: { maxSteps: budget[0], maxWallMs: budget[1] }, used: { steps: used[0], wallMs: used[1] } })

describe('reservationOf', () => {
  it('a live member reserves its budget, or what it ran past it', () => {
    for (const s of ['queued', 'running', 'attention', 'paused'] as const) {
      expect(reservationOf(m(s, [200, 3_600_000], [5, 10]))).toEqual({ maxSteps: 200, maxWallMs: 3_600_000 })
    }
    expect(reservationOf(m('running', [200, 1000], [250, 2000]))).toEqual({ maxSteps: 250, maxWallMs: 2000 })
  })
  it('an ended member holds only what it used (the rest went back to the tree)', () => {
    for (const s of ['done', 'failed', 'cancelled'] as const) {
      expect(reservationOf(m(s, [200, 3_600_000], [7, 9000]))).toEqual({ maxSteps: 7, maxWallMs: 9000 })
    }
  })
})

describe('committedOf (final fix wave I1: children\'s steps only)', () => {
  it('every child\'s reservation in steps — the coordinator is not in the tree, wall time is no dimension', () => {
    const kids = [m('running', [200, 3_600_000], [1, 1]), m('cancelled', [200, 3_600_000], [3, 1000]), m('running', [100, 60_000], [150, 1])]
    expect(committedOf(kids)).toEqual({ maxSteps: 200 + 3 + 150 })
    expect(committedOf([])).toEqual({ maxSteps: 0 })
  })
  it('what is left of the tree never goes negative', () => {
    expect(treeRemaining({ maxSteps: 2000 }, [m('running', [200, 1], [0, 0])])).toEqual({ maxSteps: 1800 })
    expect(treeRemaining({ maxSteps: 100 }, [m('running', [200, 1], [0, 0])])).toEqual({ maxSteps: 0 })
  })
  it('a tree budget is steps only, clamped, defaulted (an old row\'s maxWallMs is dropped)', () => {
    expect(normalizeTreeBudget({ maxSteps: 2000, maxWallMs: 28_800_000 })).toEqual({ maxSteps: 2000 })
    expect(normalizeTreeBudget(undefined)).toEqual({ maxSteps: 2000 })
    expect(normalizeTreeBudget({ maxSteps: 50_000 })).toEqual({ maxSteps: 10_000 })
    expect(normalizeTreeBudget({ maxSteps: 0 })).toEqual({ maxSteps: 1 })
  })
})
