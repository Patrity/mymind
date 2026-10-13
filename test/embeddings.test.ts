import { describe, it, expect, vi, beforeEach } from 'vitest'

const DIM = 2560
const zeroVec = Array(DIM).fill(0)

// Stub globals before importing the module under test
beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

// embed() now sources its endpoint from the AI config registry via
// withFailover('embeddings', fn). We mock the resolver to drive `fn` against a
// single fake ResolvedModel; the TEI request shape + dim-gating stay under test.
function mockResolver(model: { baseURL?: string | null, apiKey?: string | null } | null) {
  vi.doMock('@mymind/core/lib/ai/registry/resolve', () => ({
    withFailover: async (_usage: string, fn: (m: unknown) => Promise<unknown>) => {
      if (!model) throw new Error('embeddings not configured')
      return fn({ baseURL: model.baseURL ?? null, apiKey: model.apiKey ?? null })
    }
  }))
}

describe('embed', () => {
  it('returns a 2560-length vector for a single text', async () => {
    mockResolver({ baseURL: 'http://tei.local', apiKey: undefined })
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([zeroVec]))

    const { embed } = await import('@mymind/core/lib/ai/embeddings')
    const result = await embed(['hello'])
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveLength(DIM)
  })

  it('returns empty array for empty input without calling $fetch', async () => {
    mockResolver({ baseURL: 'http://tei.local', apiKey: undefined })
    const fetchSpy = vi.fn()
    vi.stubGlobal('$fetch', fetchSpy)

    const { embed } = await import('@mymind/core/lib/ai/embeddings')
    const result = await embed([])
    expect(result).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws when embeddings are not configured (no resolvable model)', async () => {
    mockResolver(null)
    vi.stubGlobal('$fetch', vi.fn())

    const { embed } = await import('@mymind/core/lib/ai/embeddings')
    await expect(embed(['x'])).rejects.toThrow('embeddings not configured')
  })

  it('throws when the response vector has the wrong dimension', async () => {
    mockResolver({ baseURL: 'http://tei.local', apiKey: undefined })
    // Return a vector of wrong dimension (e.g. 768)
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(768).fill(0)]))

    const { embed } = await import('@mymind/core/lib/ai/embeddings')
    await expect(embed(['x'])).rejects.toThrow('embedding dim mismatch')
  })

  it('sends authorization header when apiKey is provided', async () => {
    mockResolver({ baseURL: 'http://tei.local', apiKey: 'secret-key' })
    const fetchSpy = vi.fn().mockResolvedValue([zeroVec])
    vi.stubGlobal('$fetch', fetchSpy)

    const { embed } = await import('@mymind/core/lib/ai/embeddings')
    await embed(['test'])
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/embed'),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer secret-key' })
      })
    )
  })
})

describe('embed transport', () => {
  it('calls the OpenAI /embeddings route with model + input and orders data by index', async () => {
    const a = Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0))
    const b = Array(DIM).fill(0).map((_, i) => (i === 1 ? 1 : 0))
    vi.doMock('@mymind/core/lib/ai/registry/resolve', () => ({
      withFailover: async (_u: string, fn: (m: unknown) => Promise<unknown>) =>
        fn({ baseURL: 'http://litellm.local/', apiKey: 'k', modelId: 'qwen3-embedding-4b' })
    }))
    const fetchSpy = vi.fn().mockResolvedValue({ data: [{ embedding: b, index: 1 }, { embedding: a, index: 0 }] })
    vi.stubGlobal('$fetch', fetchSpy)

    const { embed } = await import('@mymind/core/lib/ai/embeddings')
    const out = await embed(['x', 'y'])
    expect(out[0]![0]).toBe(1)
    expect(out[1]![1]).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]![0]).toBe('http://litellm.local/embeddings')
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ body: { model: 'qwen3-embedding-4b', input: ['x', 'y'] } })
  })

  it('falls back to TEI /embed when the OpenAI route 404s', async () => {
    mockResolver({ baseURL: 'http://tei.local', apiKey: undefined })
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith('/embeddings')) throw Object.assign(new Error('Not Found'), { statusCode: 404 })
      return [zeroVec]
    })
    vi.stubGlobal('$fetch', fetchSpy)

    const { embed } = await import('@mymind/core/lib/ai/embeddings')
    expect(await embed(['x'])).toHaveLength(1)
    expect(fetchSpy.mock.calls.map(c => c[0])).toEqual(['http://tei.local/embeddings', 'http://tei.local/embed'])
  })

  it('does not fall back on non-404 errors', async () => {
    mockResolver({ baseURL: 'http://litellm.local', apiKey: 'k' })
    const fetchSpy = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }))
    vi.stubGlobal('$fetch', fetchSpy)

    const { embed } = await import('@mymind/core/lib/ai/embeddings')
    await expect(embed(['x'])).rejects.toThrow('boom')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('embedOne', () => {
  it('returns a single flat vector', async () => {
    mockResolver({ baseURL: 'http://tei.local', apiKey: undefined })
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([zeroVec]))

    const { embedOne } = await import('@mymind/core/lib/ai/embeddings')
    const v = await embedOne('hello')
    expect(v).toHaveLength(DIM)
  })
})
