import { describe, it, expect } from 'vitest'
import { buildGeneratedImageValues } from '../server/services/images'

describe('buildGeneratedImageValues', () => {
  const base = { storageKey: 'k', mime: 'image/png', ext: 'png', kind: 'image', width: 1024, height: 1024, size: 999 }

  it('seeds the prompt as summary, marks enrich done, tags generated, and is private', () => {
    const v = buildGeneratedImageValues({ ...base, prompt: 'a red bicycle', embedding: [0.1, 0.2] })
    expect(v.summary).toBe('a red bicycle')
    expect(v.enrichStatus).toBe('done')
    expect(v.tags).toEqual(['generated'])
    expect(v.embedding).toEqual([0.1, 0.2])
    expect(v.isPublic).toBe(false)
    expect(v.makeDocument).toBe(false)
    expect(v.storageKey).toBe('k')
  })

  it('stores a null embedding when embedding failed', () => {
    const v = buildGeneratedImageValues({ ...base, prompt: 'x', embedding: null })
    expect(v.embedding).toBeNull()
    expect(v.summary).toBe('x')
    expect(v.enrichStatus).toBe('done') // still searchable by trigram on summary
  })
})
