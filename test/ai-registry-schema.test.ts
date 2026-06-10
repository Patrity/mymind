// test/ai-registry-schema.test.ts
import { describe, it, expect } from 'vitest'
import { parseConfig, redactDoc } from '../server/lib/ai/registry/schema'
import { emptyDoc } from '../server/lib/ai/registry/types'

function doc() {
  return {
    version: 1 as const,
    providers: [{ id: 'p1', name: 'Local', kind: 'openai-compatible' as const, baseURL: 'http://x/v1', apiKeyEnc: 'ENC' }],
    models: [{ id: 'm1', providerId: 'p1', modelId: 'qwen', label: 'Qwen', dim: null }],
    assignments: { ...emptyDoc().assignments, reasoning: ['m1'] }
  }
}

describe('config schema', () => {
  it('parses a valid document', () => {
    expect(parseConfig(doc()).assignments.reasoning).toEqual(['m1'])
  })

  it('rejects a model referencing a missing provider', () => {
    const d = doc(); d.models[0]!.providerId = 'nope'
    expect(() => parseConfig(d)).toThrow(/provider/i)
  })

  it('rejects an assignment referencing a missing model', () => {
    const d = doc(); d.assignments.reasoning = ['ghost']
    expect(() => parseConfig(d)).toThrow(/model/i)
  })

  it('rejects an openai-compatible provider with no baseURL', () => {
    const d = doc(); d.providers[0]!.baseURL = null
    expect(() => parseConfig(d)).toThrow(/baseURL/i)
  })

  it('redactDoc strips ciphertext and sets hasKey', () => {
    const r = redactDoc(parseConfig(doc()))
    const p = r.providers[0]! as Record<string, unknown>
    expect(p.apiKeyEnc).toBeUndefined()
    expect(p.hasKey).toBe(true)
  })
})
