import { describe, it, expect } from 'vitest'
import { qAxis, qMul, vRot, qFromTo, angleOf, decayQ, mapSphere, qConj } from './arcball'

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

describe('arcball', () => {
  it('rotates a vector 90° about Y so +X → -Z', () => {
    const q = qAxis(0, 1, 0, Math.PI / 2)
    const r = vRot({ x: 1, y: 0, z: 0 }, q)
    expect(close(r.x, 0)).toBe(true)
    expect(close(r.z, -1)).toBe(true)
  })
  it('qFromTo builds the rotation carrying v0 onto v1', () => {
    const v0 = { x: 1, y: 0, z: 0 }, v1 = { x: 0, y: 1, z: 0 }
    const r = vRot(v0, qFromTo(v0, v1))
    expect(close(r.x, 0)).toBe(true); expect(close(r.y, 1)).toBe(true)
  })
  it('decayQ shrinks a rotation angle by the friction factor', () => {
    const q = qAxis(0, 1, 0, 0.4)
    expect(angleOf(decayQ(q, 0.5))).toBeCloseTo(0.2, 4)
  })
  it('decayQ is safe at ~zero angle', () => {
    const q = qAxis(0, 1, 0, 1e-9)
    expect(angleOf(decayQ(q, 0.9))).toBeLessThan(1e-4)
  })
  it('mapSphere returns a unit vector inside the ball and normalizes outside', () => {
    const inside = mapSphere(110, 100, 100, 100, 100) // 10px right of center, R=100
    expect(close(Math.hypot(inside.x, inside.y, inside.z), 1, 1e-6)).toBe(true)
    const outside = mapSphere(500, 100, 100, 100, 100)
    expect(close(outside.z, 0)).toBe(true)
    expect(close(Math.hypot(outside.x, outside.y), 1, 1e-6)).toBe(true)
  })
  it('qConj inverts a unit quaternion', () => {
    const q = qAxis(0, 1, 0, 0.7)
    const id = qMul(q, qConj(q))
    expect(close(id.w, 1, 1e-6)).toBe(true)
  })
})
