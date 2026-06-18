import { describe, it, expect } from 'vitest'
import { collapseChunksToSources } from '../server/lib/chunking/collapse'

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
