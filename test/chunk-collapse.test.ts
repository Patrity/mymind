import { describe, it, expect } from 'vitest'
import { collapseChunksToSources, collapseChunksToHits } from '../server/lib/chunking/collapse'

describe('collapseChunksToSources', () => {
  it('keeps the best (first-seen) source id, deduped, order preserved', () => {
    const hits = [
      { sourceId: 'A' }, { sourceId: 'B' }, { sourceId: 'A' }, { sourceId: 'C' }
    ]
    expect(collapseChunksToSources(hits)).toEqual(['A', 'B', 'C'])
  })
  it('handles empty input', () => {
    expect(collapseChunksToSources([])).toEqual([])
  })
})

describe('collapseChunksToHits', () => {
  it('keeps the first-seen (min-distance) hit per source, order preserved', () => {
    const hits = [
      { sourceId: 'A', distance: 0.1 },
      { sourceId: 'B', distance: 0.2 },
      { sourceId: 'A', distance: 0.5 }, // later, worse → dropped
      { sourceId: 'C', distance: 0.3 }
    ]
    expect(collapseChunksToHits(hits)).toEqual([
      { sourceId: 'A', distance: 0.1 },
      { sourceId: 'B', distance: 0.2 },
      { sourceId: 'C', distance: 0.3 }
    ])
  })
  it('handles empty input', () => {
    expect(collapseChunksToHits([])).toEqual([])
  })
})
