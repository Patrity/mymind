import { describe, it, expect, vi, beforeEach } from 'vitest'

const chatMock = vi.fn()
vi.mock('../server/lib/ai/chat', () => ({ chat: (...a: unknown[]) => chatMock(...a) }))

import { contextualizeChunk } from '../server/lib/chunking/contextualize'

beforeEach(() => { chatMock.mockReset() })

describe('contextualizeChunk', () => {
  it('returns the LLM context when enabled and the call succeeds', async () => {
    chatMock.mockResolvedValue('This snippet covers DB setup.')
    const ctx = await contextualizeChunk({ doc: 'full doc', chunk: 'the chunk', headingPath: 'T › H', enabled: true })
    expect(ctx).toBe('This snippet covers DB setup.')
    expect(chatMock).toHaveBeenCalledOnce()
  })

  it('falls back to headingPath when the model throws', async () => {
    chatMock.mockRejectedValue(new Error('rig down'))
    const ctx = await contextualizeChunk({ doc: 'd', chunk: 'c', headingPath: 'T › H', enabled: true })
    expect(ctx).toBe('T › H')
  })

  it('skips the model entirely (returns headingPath) when disabled', async () => {
    const ctx = await contextualizeChunk({ doc: 'd', chunk: 'c', headingPath: 'T › H', enabled: false })
    expect(ctx).toBe('T › H')
    expect(chatMock).not.toHaveBeenCalled()
  })
})
