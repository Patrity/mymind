// server/lib/voice/tts-failover.test.ts
import { describe, it, expect } from 'vitest'
import { createTtsSynth } from './tts-failover'
import type { ResolvedModel } from '../ai/registry/types'
import type { TtsProvider } from './providers/types'

const kokoro: ResolvedModel = { usage: 'tts', modelDefId: 'k', providerKind: 'openai-compatible', baseURL: 'http://kokoro/v1', apiKey: null, modelId: 'kokoro', label: 'Kokoro 82m', dim: null }
const chatterbox: ResolvedModel = { usage: 'tts', modelDefId: 'c', providerKind: 'openai-compatible', baseURL: 'http://chatterbox/v1', apiKey: null, modelId: 'chatterbox', label: 'Chatterbox', dim: null }

// A fake provider factory that records which model was dialed and, optionally, rejects.
function harness(failing: string[] = []) {
  const dialed: string[] = []
  const ttsFromModel = (m: ResolvedModel): TtsProvider => ({
    async *synthesize() {
      dialed.push(m.label)
      if (failing.includes(m.label)) throw new Error('TTS failed: 400')
      yield new Uint8Array([1, 2, 3])
    }
  })
  const obs = { recordEvent: () => {} }
  const synth = createTtsSynth({ resolveChain: async () => [kokoro, chatterbox], ttsFromModel, obs })
  return { dialed, synth }
}

async function drain(it: AsyncIterable<Uint8Array>) { const out: Uint8Array[] = []; for await (const c of it) out.push(c); return out }

describe('createTtsSynth — provider pinning', () => {
  it('dials the provider that owns the chosen voice FIRST, never the chain head', async () => {
    const { dialed, synth } = harness()
    await drain(synth('hello', { voice: 'Abigail.wav', provider: 'Chatterbox' }))
    expect(dialed).toEqual(['Chatterbox'])
  })

  it('keeps registry chain order when no provider is given (legacy clients)', async () => {
    const { dialed, synth } = harness()
    await drain(synth('hello', { voice: 'af_heart' }))
    expect(dialed).toEqual(['Kokoro 82m'])
  })

  it('keeps chain order for an unknown provider label', async () => {
    const { dialed, synth } = harness()
    await drain(synth('hello', { voice: 'x', provider: 'Nope' }))
    expect(dialed).toEqual(['Kokoro 82m'])
  })

  it('still fails over when the pinned provider errors', async () => {
    const { dialed, synth } = harness(['Chatterbox'])
    const out = await drain(synth('hello', { voice: 'Abigail.wav', provider: 'Chatterbox' }))
    expect(dialed).toEqual(['Chatterbox', 'Kokoro 82m'])
    expect(out).toHaveLength(1)
  })
})
