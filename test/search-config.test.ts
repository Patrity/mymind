import { describe, it, expect } from 'vitest'
import { mergeSearchConfig } from '@mymind/core/lib/search/config'

describe('mergeSearchConfig', () => {
  it('returns defaults for empty/null input', () => {
    expect(mergeSearchConfig(null)).toEqual({
      rerankTopK: 12, rerankRelBand: 0.6, cosineFloor: 1.0, candidatesPerLane: 8, maxCandidates: 50,
      hnswEfSearchMin: 100, hnswIterativeScan: true, lexicalFts: true
    })
    expect(mergeSearchConfig(undefined)).toEqual(mergeSearchConfig({}))
  })
  it('overrides only provided keys', () => {
    expect(mergeSearchConfig({ rerankRelBand: 0.5, cosineFloor: 0.7 })).toEqual({
      rerankTopK: 12, rerankRelBand: 0.5, cosineFloor: 0.7, candidatesPerLane: 8, maxCandidates: 50,
      hnswEfSearchMin: 100, hnswIterativeScan: true, lexicalFts: true
    })
  })
  it('lets the retrieval knobs be turned via the same settings row (ef_search floor, iterative scan, FTS lane)', () => {
    expect(mergeSearchConfig({ hnswEfSearchMin: 200, hnswIterativeScan: false, lexicalFts: false })).toMatchObject({
      hnswEfSearchMin: 200, hnswIterativeScan: false, lexicalFts: false
    })
  })
})
