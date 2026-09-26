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

  it('parses a config stored BEFORE a usage existed, defaulting the new one to empty', () => {
    // Adding a usage to USAGES must never invalidate a config written without it. When the
    // assignments schema required every key, adding `jev` made a real stored config fail to
    // parse — and a parse failure reads as "AI not configured", so the entire provider and
    // model set appeared to vanish and the app redirected to onboarding.
    const older = doc()
    delete (older.assignments as Record<string, unknown>).jev
    delete (older.assignments as Record<string, unknown>).rerank

    const parsed = parseConfig(older)
    expect(parsed.assignments.jev).toEqual([])
    expect(parsed.assignments.rerank).toEqual([])
    // The parts that WERE stored must survive intact — the point is that nothing is lost.
    expect(parsed.assignments.reasoning).toEqual(['m1'])
    expect(parsed.providers).toHaveLength(1)
    expect(parsed.models).toHaveLength(1)
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

  it('redactDoc leaks no ciphertext under serialization and reports hasKey:false for null keys', () => {
    const d = doc()
    d.providers[0]!.apiKeyEnc = 'SUPER-SECRET-CIPHERTEXT'
    d.providers.push({ id: 'p2', name: 'Keyless', kind: 'openai-compatible' as const, baseURL: 'http://y/v1', apiKeyEnc: null })
    d.models.push({ id: 'm2', providerId: 'p2', modelId: 'k', label: 'K', dim: null })
    const json = JSON.stringify(redactDoc(parseConfig(d)))
    expect(json).not.toContain('SUPER-SECRET-CIPHERTEXT')
    expect(json).not.toContain('apiKeyEnc')
    const r = redactDoc(parseConfig(d))
    expect(r.providers.find(p => p.id === 'p2')!.hasKey).toBe(false)
  })
})

describe('ModelDef.contextWindow', () => {
  it('defaults to null for docs written before the field existed', () => {
    expect(parseConfig(doc()).models[0]!.contextWindow).toBeNull()
  })

  it('accepts a positive integer', () => {
    const d = doc(); d.models[0] = { ...d.models[0]!, contextWindow: 131072 } as typeof d.models[0]
    expect(parseConfig(d).models[0]!.contextWindow).toBe(131072)
  })

  it('rejects zero, negatives and fractions', () => {
    for (const bad of [0, -1, 1.5]) {
      const d = doc(); d.models[0] = { ...d.models[0]!, contextWindow: bad } as typeof d.models[0]
      expect(() => parseConfig(d)).toThrow()
    }
  })
})
