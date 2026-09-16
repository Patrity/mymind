import { describe, it, expect } from 'vitest'
import { handleTurn } from './orchestrator'
import type { AgentEvent } from '../agent/run'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

const tts = { synthesize: async function* () {} }

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, calibratedRefKey: null, starredSeeds: [], isDefault: true
}

async function* fakeRun(): AsyncGenerator<AgentEvent> {
  yield { type: 'text-delta', text: 'Done.' }
  yield { type: 'tool-result', name: 'generate_image', summary: 'generated image (real1)', images: [{ id: 'real1', url: '/api/images/real1/raw', alt: 'a cat' }] }
}

describe('handleTurn server-authored image embed', () => {
  it('appends the real embed to the assistant message and emits it live', async () => {
    const events: { type: string; text?: string }[] = []
    const ac = new AbortController()
    const out = await handleTurn('draw a cat', [], {
      tts: tts as never, preset, signal: ac.signal, speak: false,
      emit: (e) => events.push(e as { type: string; text?: string }),
      runAgent: fakeRun as never
    })
    const assistant = out[out.length - 1]!
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toContain('![a cat](/api/images/real1/raw)')
    // streamed live as a transcript event too
    expect(events.some(e => e.type === 'transcript' && (e.text ?? '').includes('/api/images/real1/raw'))).toBe(true)
  })
})
