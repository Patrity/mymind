import { describe, it, expect } from 'vitest'
import { clampPaging, buildPage, DEFAULT_LIMIT, MAX_LIMIT } from './paging'

describe('clampPaging', () => {
  it('defaults limit and offset when both are absent', () => {
    expect(clampPaging()).toEqual({ limit: DEFAULT_LIMIT, offset: 0 })
  })

  it('caps limit at MAX_LIMIT', () => {
    expect(clampPaging(5000).limit).toBe(MAX_LIMIT)
  })

  it('floors limit at 1', () => {
    expect(clampPaging(0).limit).toBe(1)
    expect(clampPaging(-10).limit).toBe(1)
  })

  it('floors offset at 0', () => {
    expect(clampPaging(25, -5).offset).toBe(0)
  })

  it('truncates fractional input', () => {
    expect(clampPaging(10.7, 3.9)).toEqual({ limit: 10, offset: 3 })
  })
})

describe('buildPage', () => {
  it('reports hasMore when more rows remain past this window', () => {
    expect(buildPage(['a', 'b'], 10, 2, 0)).toEqual({ items: ['a', 'b'], total: 10, hasMore: true })
  })

  it('reports hasMore false on the exact boundary', () => {
    expect(buildPage(['a', 'b'], 2, 2, 0).hasMore).toBe(false)
  })

  it('reports hasMore false on the final partial page', () => {
    expect(buildPage(['c'], 3, 2, 2).hasMore).toBe(false)
  })

  it('reports hasMore true mid-way through a large set', () => {
    expect(buildPage(['c', 'd'], 100, 2, 2).hasMore).toBe(true)
  })

  it('handles an empty result set', () => {
    expect(buildPage([], 0, 25, 0)).toEqual({ items: [], total: 0, hasMore: false })
  })

  it('handles an offset past the end', () => {
    expect(buildPage([], 10, 25, 999)).toEqual({ items: [], total: 10, hasMore: false })
  })
})
