// Cycle 83 Task 3 fix round 1 (I2): the tree budget formula — the ONE copy the core's spawn/resume
// checks and the UI's tree meter both use.
import { describe, it, expect } from 'vitest'
import { committedOf, reservationOf, type TreeMember } from './workstreams'

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

describe('committedOf', () => {
  it('the coordinator (always as live, even ended) + every child', () => {
    const coord = m('done', [400, 7_200_000], [9, 5000])
    const kids = [m('running', [200, 3_600_000], [1, 1]), m('cancelled', [200, 3_600_000], [3, 1000])]
    expect(committedOf(coord, kids)).toEqual({ maxSteps: 400 + 200 + 3, maxWallMs: 7_200_000 + 3_600_000 + 1000 })
    expect(committedOf(m('running', [400, 100], [500, 50]), [])).toEqual({ maxSteps: 500, maxWallMs: 100 })
  })
})
