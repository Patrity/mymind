import { describe, it, expect } from 'vitest'
import { activePath, branchIndex, branchTip } from './conversation-path'

// a → b → c   and   a → b → d   (c and d are siblings; two branches)
const rows = [
  { id: 'a', parentId: null },
  { id: 'b', parentId: 'a' },
  { id: 'c', parentId: 'b' },
  { id: 'd', parentId: 'b' }
]

describe('activePath', () => {
  it('walks from the leaf to the root and returns root-first', () => {
    expect(activePath(rows, 'c').map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(activePath(rows, 'd').map(r => r.id)).toEqual(['a', 'b', 'd'])
  })

  it('excludes the sibling that is not on the active path', () => {
    expect(activePath(rows, 'c').map(r => r.id)).not.toContain('d')
  })

  it('returns [] for a null leaf — the caller falls back, it does not guess', () => {
    expect(activePath(rows, null)).toEqual([])
  })

  it('returns [] for a leaf that is not present rather than a partial path', () => {
    expect(activePath(rows, 'zzz')).toEqual([])
  })

  it('does not hang on a cycle — a corrupt parent chain must terminate', () => {
    const cyclic = [{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }]
    expect(activePath(cyclic, 'x').length).toBeLessThanOrEqual(2)
  })

  it('handles a single-message thread', () => {
    expect(activePath([{ id: 'only', parentId: null }], 'only').map(r => r.id)).toEqual(['only'])
  })
})

describe('branchIndex', () => {
  it('numbers siblings 1-based with their total', () => {
    const ix = branchIndex(rows)
    expect(ix.get('c')).toEqual({ index: 1, total: 2 })
    expect(ix.get('d')).toEqual({ index: 2, total: 2 })
  })

  it('reports total 1 for a message with no siblings, so the pager can hide', () => {
    expect(branchIndex(rows).get('b')).toEqual({ index: 1, total: 1 })
  })

  it('treats roots as siblings of each other', () => {
    const twoRoots = [{ id: 'r1', parentId: null }, { id: 'r2', parentId: null }]
    expect(branchIndex(twoRoots).get('r2')).toEqual({ index: 2, total: 2 })
  })
})

describe('branchTip', () => {
  it('returns the node itself when it has no children', () => {
    const rows = [{ id: 'a', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' }]
    expect(branchTip(rows, 'a')).toBe('a')
  })

  it('returns null for an unknown id — no guessing, same contract as activePath', () => {
    const rows = [{ id: 'a', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' }]
    expect(branchTip(rows, 'zzz')).toBeNull()
  })

  it('follows a chain several deep to its tip', () => {
    const rows = [
      { id: 'a', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', parentId: 'a', createdAt: '2026-01-01T00:01:00.000Z' },
      { id: 'c', parentId: 'b', createdAt: '2026-01-01T00:02:00.000Z' },
      { id: 'd', parentId: 'c', createdAt: '2026-01-01T00:03:00.000Z' },
      { id: 'e', parentId: 'd', createdAt: '2026-01-01T00:04:00.000Z' }
    ]
    expect(branchTip(rows, 'a')).toBe('e')
    // starting partway down the chain lands on the same tip
    expect(branchTip(rows, 'c')).toBe('e')
  })

  it('picks the newest of two children by created_at', () => {
    const rows = [
      { id: 'a', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'older', parentId: 'a', createdAt: '2026-01-01T00:01:00.000Z' },
      { id: 'newer', parentId: 'a', createdAt: '2026-01-01T00:02:00.000Z' }
    ]
    expect(branchTip(rows, 'a')).toBe('newer')
  })

  // This fixture's rows are fed in the SAME order as created_at (older pushed before newer), so
  // on its own it cannot tell "sorts by created_at" apart from "picks whichever child is last in
  // the input array" — deleting the sort block above leaves it green. The next test closes that
  // gap by feeding rows deliberately out of order.
  it('resolves by created_at, not by input array order — the sort is load-bearing', () => {
    // 'newer' appears FIRST in the array, 'older' SECOND — the reverse of every other fixture
    // in this file. Without the sort, the last child pushed into the sibling group (in row-input
    // order) would be 'older', and this would wrongly resolve to it.
    const rows = [
      { id: 'a', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'newer', parentId: 'a', createdAt: '2026-01-01T00:02:00.000Z' },
      { id: 'older', parentId: 'a', createdAt: '2026-01-01T00:01:00.000Z' }
    ]
    expect(branchTip(rows, 'a')).toBe('newer')
  })

  it('resolves a branch-within-a-branch to the tip most recently extended', () => {
    // a → older (a leaf) ; a → newer → grandchild (deeper, and newer at the top level too)
    const rows = [
      { id: 'a', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'older', parentId: 'a', createdAt: '2026-01-01T00:01:00.000Z' },
      { id: 'newer', parentId: 'a', createdAt: '2026-01-01T00:02:00.000Z' },
      { id: 'grandchild', parentId: 'newer', createdAt: '2026-01-01T00:03:00.000Z' }
    ]
    expect(branchTip(rows, 'a')).toBe('grandchild')
  })

  it('ties on created_at break deterministically by id, the same tie-break as loadActivePath', () => {
    const rows = [
      { id: 'a', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'x1', parentId: 'a', createdAt: '2026-01-01T00:01:00.000Z' },
      { id: 'x2', parentId: 'a', createdAt: '2026-01-01T00:01:00.000Z' }
    ]
    expect(branchTip(rows, 'a')).toBe('x2')
  })

  it('does not hang on a cycle — a corrupt tree must terminate, not spin', () => {
    const cyclic = [
      { id: 'x', parentId: 'y', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'y', parentId: 'x', createdAt: '2026-01-01T00:01:00.000Z' }
    ]
    const result = branchTip(cyclic, 'x')
    expect(['x', 'y']).toContain(result)
  })
})
