import { describe, it, expect } from 'vitest'
import { meanPool, computeLayout } from './layout'

describe('layout', () => {
  it('meanPool averages component-wise', () => {
    expect(meanPool([[0, 2], [2, 4]])).toEqual([1, 3])
  })
  it('meanPool of empty is a zero-length vector (caller filters)', () => {
    expect(meanPool([])).toEqual([])
  })
  it('computeLayout returns one 3D row per item, deterministically for a fixed seed', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ type: 'memory', id: `m${i}`, vector: [Math.sin(i), Math.cos(i), i / 30] }))
    const a = computeLayout(items, 42)
    const b = computeLayout(items, 42)
    expect(a).toHaveLength(30)
    expect(a[0]).toHaveProperty('x'); expect(a[0]).toHaveProperty('z')
    expect(a).toEqual(b) // same seed → identical layout
  })
})
