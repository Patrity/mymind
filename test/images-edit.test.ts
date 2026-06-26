import { describe, it, expect } from 'vitest'
import { buildGeneratedImageValues } from '../server/services/images'

describe('buildGeneratedImageValues tags', () => {
  const base = { storageKey: 'k', mime: 'image/webp', ext: 'webp', kind: 'image', width: 1024, height: 1024, size: 9 }
  it('uses the provided tags (e.g. generated+edited)', () => {
    const v = buildGeneratedImageValues({ ...base, prompt: 'make it blue', embedding: null, tags: ['generated', 'edited'] })
    expect(v.tags).toEqual(['generated', 'edited'])
    expect(v.summary).toBe('make it blue')
    expect(v.enrichStatus).toBe('done')
  })
})
