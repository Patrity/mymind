// Cycle 85 Task 4 fix round 1: inside an eval world a run's model override may be a subagents model
// (it leads the reasoning chain); outside one, an override only reorders within `reasoning`.
import { describe, it, expect, vi, beforeAll } from 'vitest'

let inEval = false
vi.mock('@mymind/core/lib/eval/context', async (orig) => ({ ...(await orig<object>()), currentEvalScope: () => (inEval ? { runId: 'r' } : undefined) }))
const doc = { value: null as unknown }
vi.mock('@mymind/core/lib/ai/registry/store', () => ({ loadConfig: async () => doc.value }))

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = 'test-secret-please-ignore-0123456789'
  const { emptyDoc } = await import('@mymind/core/lib/ai/registry/types')
  const { encryptSecret } = await import('@mymind/core/lib/ai/registry/crypto')
  doc.value = {
    version: 1,
    providers: [{ id: 'p1', name: 'A', kind: 'openai-compatible', baseURL: 'http://a/v1', apiKeyEnc: encryptSecret('k') }],
    models: [
      { id: 'm1', providerId: 'p1', modelId: 'qwen', label: 'Qwen', dim: null, contextWindow: null },
      { id: 's1', providerId: 'p1', modelId: 'haiku', label: 'Haiku', dim: null, contextWindow: null }
    ],
    assignments: { ...emptyDoc().assignments, reasoning: ['m1'], subagents: ['s1'] }
  }
})

describe('reasoningChain with an override', () => {
  it('in an eval world a subagents model leads; outside it is ignored', async () => {
    const { reasoningChain } = await import('@mymind/core/lib/agent/model')
    inEval = true
    expect((await reasoningChain('s1')).map(m => m.modelDefId)).toEqual(['s1', 'm1'])
    inEval = false
    expect((await reasoningChain('s1')).map(m => m.modelDefId)).toEqual(['m1'])
    expect((await reasoningChain(null)).map(m => m.modelDefId)).toEqual(['m1'])
  })
})
