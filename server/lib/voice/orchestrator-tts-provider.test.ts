// server/lib/voice/orchestrator-tts-provider.test.ts
import { describe, it, expect } from 'vitest'
import { handleTurn } from './orchestrator'
import type { AgentEvent } from '../agent/run'

async function* fakeRun(): AsyncGenerator<AgentEvent> {
  yield { type: 'text-delta', text: 'This is a full sentence that is comfortably longer than the sixty character chunk floor.' }
}

describe('handleTurn TTS provider threading', () => {
  it('passes the chosen TTS provider alongside the voice to tts.synthesize', async () => {
    const seen: { voice: string; provider?: string | null }[] = []
    const tts = { synthesize: async function* (_t: string, opts: { voice: string; provider?: string | null }) { seen.push({ voice: opts.voice, provider: opts.provider }) } }
    const ac = new AbortController()
    await handleTurn('hi', [], {
      tts: tts as never, voice: 'Abigail.wav', ttsProvider: 'Chatterbox', signal: ac.signal, speak: true,
      emit: () => {}, runAgent: fakeRun as never
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(s => s.voice === 'Abigail.wav' && s.provider === 'Chatterbox')).toBe(true)
  })
})
