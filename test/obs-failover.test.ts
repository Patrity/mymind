import { describe, it, expect } from 'vitest'
import { withFailoverOver } from '../server/lib/ai/registry/resolve'
import type { ResolvedModel } from '../server/lib/ai/registry/types'
import type { SpanInput } from '../server/lib/observability/types'

const chain: ResolvedModel[] = [
  { usage: 'reasoning', modelDefId: 'm1', providerKind: 'openai-compatible', baseURL: 'http://a', apiKey: 'k', modelId: 'broken', label: 'Broken', dim: null },
  { usage: 'reasoning', modelDefId: 'm2', providerKind: 'openai-compatible', baseURL: 'http://b', apiKey: 'k', modelId: 'good', label: 'Good', dim: null }
]

describe('withFailoverOver instrumentation', () => {
  it('records one attempt row per model tried, with statuses, via the injected recorder', async () => {
    const events: SpanInput[] = []
    const obs = { recordEvent: (e: SpanInput) => events.push(e) }
    const out = await withFailoverOver('reasoning', chain, async (m) => {
      if (m.modelId === 'broken') throw new Error('no usable content')
      return 'real answer'
    }, obs)
    expect(out).toBe('real answer')
    const attempts = events.filter(e => e.kind === 'attempt')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.status).toBe('error')
    expect(attempts[0]!.attempt).toBe(0)
    expect((attempts[0]!.error as { message: string }).message).toBe('no usable content')
    expect(attempts[1]!.status).toBe('ok')
    expect(attempts[1]!.attempt).toBe(1)
    // provider is host-only, never the apiKey
    expect(JSON.stringify(events)).not.toContain('"k"')
  })
})
