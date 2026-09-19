import { describe, it, expect, vi } from 'vitest'
import { runAgent, type AgentEvent } from './run'

function stream(parts: unknown[]) {
  return { fullStream: (async function* () { for (const p of parts) yield p })() }
}
async function usageOf(parts: unknown[], deps: Record<string, unknown> = {}) {
  const events: AgentEvent[] = []
  for await (const e of runAgent([{ role: 'user', content: 'hi' }], { signal: new AbortController().signal },
    { streamText: vi.fn(() => stream(parts)) as never, tools: [], buildSystemPrompt: async () => 's', ...deps })) events.push(e)
  return events.filter(e => e.type === 'usage')
}

describe('runAgent context accounting', () => {
  it('contextTokens is the LAST step\'s input + output, not the multi-step total', async () => {
    const u = await usageOf([
      { type: 'finish-step', usage: { inputTokens: 100, outputTokens: 10 } },
      { type: 'text-delta', id: 't', delta: 'ok' },
      { type: 'finish-step', usage: { inputTokens: 150, outputTokens: 20 } },
      { type: 'finish', totalUsage: { inputTokens: 250, outputTokens: 30, totalTokens: 280 } }
    ])
    expect(u).toEqual([{ type: 'usage', inputTokens: 250, outputTokens: 30, totalTokens: 280, contextTokens: 170 }])
  })

  it('omits contextTokens when no step reported usage', async () => {
    const u = await usageOf([{ type: 'text-delta', id: 't', delta: 'ok' }, { type: 'finish', totalUsage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } }])
    expect(u[0]).not.toHaveProperty('contextTokens')
  })

  it('stamps the modelDefId of the model that produced the stream', async () => {
    const u = await usageOf(
      [{ type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1 } }, { type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }],
      { chain: [{ model: {}, modelDefId: 'haiku-def' }] }
    )
    expect(u[0]).toMatchObject({ modelDefId: 'haiku-def', contextTokens: 2 })
  })
})
