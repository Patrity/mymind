// test/ai-chat-timeout.test.ts
//
// chat()'s per-attempt timeout (cycle 76 final review I1): the default stays one minute, and a
// caller can widen it — the reflector asks for 6k output tokens and needs longer. The failover
// chain is stubbed to one fake model, so no DB and no network.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@mymind/core/lib/ai/registry/resolve', () => ({
  withFailover: async (_usage: string, fn: (m: unknown) => Promise<unknown>) =>
    fn({ baseURL: 'http://model.test/v1', apiKey: 'k', modelId: 'm' })
}))

import { chat, CHAT_TIMEOUT_MS } from '@mymind/core/lib/ai/chat'

const fetchStub = vi.fn(async (_url: string, _opts: { body: { max_tokens: number } }) => ({ choices: [{ message: { content: 'ok' } }] }))
vi.stubGlobal('$fetch', fetchStub)

afterEach(() => vi.restoreAllMocks())

describe('chat timeout', () => {
  it('uses the default one-minute timeout when none is given', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    await chat('reasoning', [{ role: 'user', content: 'hi' }])
    expect(CHAT_TIMEOUT_MS).toBe(60_000)
    expect(spy).toHaveBeenCalledWith(60_000)
  })

  it('passes a caller-supplied timeoutMs to the request signal', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    await chat('reasoning', [{ role: 'user', content: 'hi' }], { maxTokens: 6000, timeoutMs: 120_000 })
    expect(spy).toHaveBeenCalledWith(120_000)
    expect(fetchStub.mock.calls.at(-1)![1].body.max_tokens).toBe(6000)
  })
})
