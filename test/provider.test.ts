import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({
  ai: { reasoning: { baseURL: 'http://x/v1', apiKey: 'k', model: 'm' }, embeddings: { baseURL: '', apiKey: '', model: 'e' } }
}))

describe('aiProvider', () => {
  it('returns config for a configured role', async () => {
    const { aiProvider } = await import('../server/lib/ai/provider')
    expect(aiProvider('reasoning').model).toBe('m')
  })
  it('throws for an unconfigured role when required', async () => {
    const { aiProvider } = await import('../server/lib/ai/provider')
    expect(() => aiProvider('embeddings', { required: true })).toThrow()
  })
})
