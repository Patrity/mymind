// server/lib/voice/orchestrator-speakable.test.ts
// The speech half of this file (sanitized synth text, unfragmented IPs) moved with TTS to the web's
// voice socket in cycle 81 — see turn-speaker.test.ts. What stays: a spoken turn still persists the
// RAW markdown, never a spoken form.
import { describe, it, expect } from 'vitest'
import { handleTurn } from './orchestrator'
import type { AgentEvent } from '../agent/run'

function fakeDeps() {
  return {
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
  it('persists RAW markdown to history, not the spoken form', async () => {
    const out = await handleTurn('hi', [], fakeDeps() as never)
    const last = out[out.length - 1] as { role: string; content: string }
    expect(last.role).toBe('assistant')
    expect(last.content).toContain('**')
    expect(last.content).toContain('192.168.2.25')
  })
})
