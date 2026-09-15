// server/lib/voice/orchestrator-speakable.test.ts
import { describe, it, expect } from 'vitest'
import { handleTurn } from './orchestrator'
import type { AgentEvent } from '../agent/run'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, isDefault: true
}

function fakeDeps(spoken: string[]) {
  return {
    tts: {
      async *synthesize(text: string) {
        spoken.push(text)
        yield { kind: 'begin', sampleRate: 24000 }
        yield { kind: 'pcm', bytes: new Uint8Array([1]) }
      }
    } as never,
    preset,
    signal: new AbortController().signal,
    speak: true,
    emit: () => {},
    async *runAgent(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', text: 'Here are your **6 ' } as AgentEvent
      yield { type: 'text-delta', text: 'projects**. The rig is at 192.168.2.25 today. ' } as AgentEvent
    }
  }
}

describe('handleTurn speech path', () => {
  it('speaks sanitized text and never sends markdown to the synth', async () => {
    const spoken: string[] = []
    await handleTurn('hi', [], fakeDeps(spoken) as never)
    expect(spoken.join(' ')).not.toContain('*')
    expect(spoken.join(' ')).toContain('6 projects')
  })

  it('does not fragment an IP address into separate synth calls', async () => {
    const spoken: string[] = []
    await handleTurn('hi', [], fakeDeps(spoken) as never)
    const ipCalls = spoken.filter(s => s.includes('dot'))
    expect(ipCalls).toHaveLength(1)
  })

  it('persists RAW markdown to history, not the spoken form', async () => {
    const spoken: string[] = []
    const out = await handleTurn('hi', [], fakeDeps(spoken) as never)
    const last = out[out.length - 1] as { role: string; content: string }
    expect(last.role).toBe('assistant')
    expect(last.content).toContain('**')
    expect(last.content).toContain('192.168.2.25')
  })
})
