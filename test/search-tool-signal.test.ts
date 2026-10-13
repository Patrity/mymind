import { describe, it, expect, vi } from 'vitest'

const search = vi.fn(async () => ({ results: [] }))
vi.mock('@mymind/core/lib/search/resolve', () => ({ searchProvider: async () => ({ search }) }))

const { toolByName } = await import('@mymind/core/lib/agent/tools')

describe('web_search tool', () => {
  it('threads the tool-context abort signal into the search options', async () => {
    const ac = new AbortController()
    await toolByName('web_search')!.handler({ query: 'q', count: 3 }, { signal: ac.signal } as never)
    expect(search).toHaveBeenCalledWith('q', { count: 3, signal: ac.signal })
  })
})
