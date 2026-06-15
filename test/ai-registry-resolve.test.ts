// test/ai-registry-resolve.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { resolveChainFrom, withFailoverOver, languageModel } from '../server/lib/ai/registry/resolve'
import { AiNotConfiguredError, AiAllFailedError } from '../server/lib/ai/registry/errors'
import { encryptSecret } from '../server/lib/ai/registry/crypto'
import { emptyDoc, EMBEDDING_DIM, type AiConfigDoc, type ResolvedModel } from '../server/lib/ai/registry/types'

beforeAll(() => { process.env.BETTER_AUTH_SECRET = 'test-secret-please-ignore-0123456789' })

function build(): AiConfigDoc {
  return {
    version: 1,
    providers: [
      { id: 'p1', name: 'A', kind: 'openai-compatible', baseURL: 'http://a/v1', apiKeyEnc: encryptSecret('k1') },
      { id: 'p2', name: 'B', kind: 'openai-compatible', baseURL: 'http://gateway/v1', apiKeyEnc: encryptSecret('k2') }
    ],
    models: [
      { id: 'm1', providerId: 'p1', modelId: 'qwen', label: 'Qwen', dim: null },
      { id: 'm2', providerId: 'p2', modelId: 'claude', label: 'Claude', dim: null },
      { id: 'e1', providerId: 'p1', modelId: 'embed', label: 'Embed', dim: EMBEDDING_DIM },
      { id: 'e2', providerId: 'p1', modelId: 'embed-bad', label: 'EmbedBad', dim: 1024 }
    ],
    assignments: { ...emptyDoc().assignments, reasoning: ['m1', 'm2'], embeddings: ['e2', 'e1'] }
  }
}

describe('resolveChainFrom', () => {
  it('returns the ordered, decrypted chain', () => {
    const chain = resolveChainFrom(build(), 'reasoning')
    expect(chain.map(m => m.modelId)).toEqual(['qwen', 'claude'])
    expect(chain[0]!.apiKey).toBe('k1')
    expect(chain[1]!.providerKind).toBe('openai-compatible')
  })

  it('throws AiNotConfiguredError for an empty usage', () => {
    expect(() => resolveChainFrom(build(), 'tts')).toThrow(AiNotConfiguredError)
  })

  it('filters the embeddings chain to dim-2560 models', () => {
    const chain = resolveChainFrom(build(), 'embeddings')
    expect(chain.map(m => m.modelId)).toEqual(['embed'])  // embed-bad (1024) dropped
  })

  it('degrades a provider with an undecryptable key to apiKey=null (one bad key does not kill the chain)', () => {
    const d = build()
    d.providers[0]!.apiKeyEnc = 'not-valid-ciphertext'  // decrypt will throw → null
    const chain = resolveChainFrom(d, 'reasoning')
    expect(chain[0]!.apiKey).toBeNull()
    expect(chain[1]!.apiKey).toBe('k2')                 // the other provider still decrypts
  })
})

describe('languageModel', () => {
  it('builds an OpenAI-compatible model without throwing', () => {
    const oai = languageModel({ usage: 'reasoning', modelDefId: 'm', providerKind: 'openai-compatible', baseURL: 'http://a/v1', apiKey: 'k', modelId: 'qwen', label: 'Q', dim: null })
    expect(oai).toBeTruthy()
  })
})

describe('withFailoverOver', () => {
  const chain: ResolvedModel[] = [
    { usage: 'bulk', modelDefId: 'm1', providerKind: 'openai-compatible', baseURL: 'http://a', apiKey: 'k', modelId: 'a', label: 'A', dim: null },
    { usage: 'bulk', modelDefId: 'm2', providerKind: 'openai-compatible', baseURL: 'http://b', apiKey: 'k', modelId: 'b', label: 'B', dim: null }
  ]

  it('uses the first model that succeeds', async () => {
    const used: string[] = []
    const out = await withFailoverOver('bulk', chain, async (m) => { used.push(m.modelId); return m.modelId.toUpperCase() })
    expect(out).toBe('A'); expect(used).toEqual(['a'])
  })

  it('falls over to the next on error', async () => {
    const out = await withFailoverOver('bulk', chain, async (m) => {
      if (m.modelId === 'a') throw new Error('down')
      return 'ok'
    })
    expect(out).toBe('ok')
  })

  it('throws AiAllFailedError when every model fails', async () => {
    await expect(withFailoverOver('bulk', chain, async () => { throw new Error('boom') }))
      .rejects.toBeInstanceOf(AiAllFailedError)
  })
})
