import { describe, it, expect, vi, beforeEach } from 'vitest'

const DIM = 2560
const zeroVec = Array(DIM).fill(0)

// Stub globals before importing the module under test
beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('embed', () => {
  it('returns a 2560-length vector for a single text', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      ai: { embeddings: { baseURL: 'http://tei.local', apiKey: undefined } }
    }))
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([zeroVec]))

    const { embed } = await import('../server/lib/ai/embeddings')
    const result = await embed(['hello'])
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveLength(DIM)
  })

  it('returns empty array for empty input without calling $fetch', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      ai: { embeddings: { baseURL: 'http://tei.local', apiKey: undefined } }
    }))
    const fetchSpy = vi.fn()
    vi.stubGlobal('$fetch', fetchSpy)

    const { embed } = await import('../server/lib/ai/embeddings')
    const result = await embed([])
    expect(result).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws when baseURL is missing', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      ai: { embeddings: { baseURL: '', apiKey: undefined } }
    }))
    vi.stubGlobal('$fetch', vi.fn())

    const { embed } = await import('../server/lib/ai/embeddings')
    await expect(embed(['x'])).rejects.toThrow('embeddings not configured')
  })

  it('throws when the response vector has the wrong dimension', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      ai: { embeddings: { baseURL: 'http://tei.local', apiKey: undefined } }
    }))
    // Return a vector of wrong dimension (e.g. 768)
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(768).fill(0)]))

    const { embed } = await import('../server/lib/ai/embeddings')
    await expect(embed(['x'])).rejects.toThrow('embedding dim mismatch')
  })

  it('sends authorization header when apiKey is provided', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      ai: { embeddings: { baseURL: 'http://tei.local', apiKey: 'secret-key' } }
    }))
    const fetchSpy = vi.fn().mockResolvedValue([zeroVec])
    vi.stubGlobal('$fetch', fetchSpy)

    const { embed } = await import('../server/lib/ai/embeddings')
    await embed(['test'])
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/embed'),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer secret-key' })
      })
    )
  })
})

describe('embedOne', () => {
  it('returns a single flat vector', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      ai: { embeddings: { baseURL: 'http://tei.local', apiKey: undefined } }
    }))
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([zeroVec]))

    const { embedOne } = await import('../server/lib/ai/embeddings')
    const v = await embedOne('hello')
    expect(v).toHaveLength(DIM)
  })
})
