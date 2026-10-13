import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@mymind/core/lib/search/store', () => ({
  loadSearchConfig: vi.fn(async () => ({ provider: 'brave', braveQps: 2.5 })),
}))
const setRate = vi.fn()
vi.mock('@mymind/core/lib/search/limiter', () => ({ braveLimiter: { setRate, acquire: vi.fn() } }))

const { searchProvider } = await import('@mymind/core/lib/search/resolve')

describe('searchProvider', () => {
  beforeEach(() => setRate.mockClear())
  it('applies the configured search.brave.qps to the shared limiter', async () => {
    await searchProvider()
    expect(setRate).toHaveBeenCalledWith(2.5)
  })
})
