import { describe, it, expect } from 'vitest'
import { mergeSearchConfig } from '../server/lib/search/config'

describe('mergeSearchConfig', () => {
  it('returns defaults for empty/null input', () => {
    expect(mergeSearchConfig(null)).toEqual({
      rerankCutoff: 0.2, cosineFloor: 1.0, candidatesPerLane: 8, maxCandidates: 50
    })
    expect(mergeSearchConfig(undefined)).toEqual(mergeSearchConfig({}))
  })
  it('overrides only provided keys', () => {
    expect(mergeSearchConfig({ rerankCutoff: 0.45, cosineFloor: 0.7 })).toEqual({
      rerankCutoff: 0.45, cosineFloor: 0.7, candidatesPerLane: 8, maxCandidates: 50
    })
  })
})
