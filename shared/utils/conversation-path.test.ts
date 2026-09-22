import { describe, it, expect } from 'vitest'
import { activePath, branchIndex } from './conversation-path'

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
