import { describe, it, expect } from 'vitest'
import { jawWeight, regionWeights, type HeadMetrics } from '../scripts/bake-head'

const M: HeadMetrics = {
  lipY: 0.0, chinY: -1.0, eyeY: 0.8, browY: 1.0,
  hingeInner: 0.3, hingeOuter: 0.9, faceHalfWidth: 1.0
}

describe('jawWeight', () => {
  it('is zero at and above the upper lip', () => {
    expect(jawWeight(M.lipY, 0, M)).toBe(0)
    expect(jawWeight(0.5, 0, M)).toBe(0)
  })

  it('is full at the chin', () => {
    expect(jawWeight(M.chinY, 0, M)).toBeCloseTo(1, 5)
  })

  it('increases monotonically from lip to chin', () => {
    const ys = [0.0, -0.2, -0.4, -0.6, -0.8, -1.0]
    const ws = ys.map(y => jawWeight(y, 0, M))
    for (let i = 1; i < ws.length; i++) expect(ws[i]!).toBeGreaterThanOrEqual(ws[i - 1]!)
  })

  it('moves the lower lip only a fraction of the chin travel', () => {
    // The whole point: a binary region translated as a block CLEAVES the head at the
    // lip line. The lower lip must trail the chin, not match it.
    const lowerLip = jawWeight(-0.15, 0, M)
    const chin = jawWeight(M.chinY, 0, M)
    expect(lowerLip).toBeGreaterThan(0)
    expect(lowerLip).toBeLessThan(chin * 0.45)
  })

  it('is reduced near the hinge so the jaw arcs', () => {
    const centre = jawWeight(M.chinY, 0, M)
    const hinge = jawWeight(M.chinY, 0.95, M)
    expect(hinge).toBeLessThan(centre)
    expect(hinge).toBeGreaterThan(0)
  })

  it('never exceeds 1 or drops below 0', () => {
    for (const y of [2, 1, 0, -1, -2]) {
      for (const x of [-2, -1, 0, 1, 2]) {
        const w = jawWeight(y, x, M)
        expect(w).toBeGreaterThanOrEqual(0)
        expect(w).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('regionWeights', () => {
  it('flags the eye band away from the midline', () => {
    expect(regionWeights({ x: 0.45, y: M.eyeY, z: 0.5 }, M).eye).toBeGreaterThan(0.5)
    expect(regionWeights({ x: 0.02, y: M.eyeY, z: 0.5 }, M).eye).toBeLessThan(0.5)
  })

  it('flags the brow band above the eyes', () => {
    expect(regionWeights({ x: 0.45, y: M.browY, z: 0.5 }, M).brow).toBeGreaterThan(0.5)
  })
})
