// server/lib/voice/orchestrator-usage.test.ts
import { describe, it, expect } from 'vitest'
import { handleTurn } from './orchestrator'
import type { VoiceEvent } from './orchestrator'
import type { AgentEvent } from '../agent/run'

function fakeDeps(events: VoiceEvent[], agentEvents: AgentEvent[]) {
  return {
    tts: { async *synthesize() { /* not exercised: speak: false */ } } as never,
    voice: 'af_heart',
    signal: new AbortController().signal,
    speak: false,
    emit: (e: VoiceEvent) => { events.push(e) },
    async *runAgent(): AsyncGenerator<AgentEvent> {
      for (const e of agentEvents) yield e
    }
  }
}

describe('handleTurn usage passthrough', () => {
  it('forwards a usage AgentEvent as a usage VoiceEvent, untouched by content handling', async () => {
    const events: VoiceEvent[] = []
    const out = await handleTurn('hi', [], fakeDeps(events, [
      { type: 'text-delta', text: 'Hello Tony.' },
      { type: 'usage', inputTokens: 120, outputTokens: 45, totalTokens: 165 }
    ]) as never)

    const usageEvents = events.filter(e => e.type === 'usage')
    expect(usageEvents).toEqual([{ type: 'usage', inputTokens: 120, outputTokens: 45, totalTokens: 165 }])

    // Metadata only: never folded into the persisted assistant text...
    const last = out[out.length - 1] as { role: string; content: string }
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('Hello Tony.')
    expect(last.content).not.toContain('165')
    // ...and never emitted as (or inside) a transcript event.
    const transcripts = events.filter(e => e.type === 'transcript')
    expect(transcripts.every(e => (e as { text: string }).text.indexOf('165') === -1)).toBe(true)
  })

  it('completes and persists normally when the agent yields no usage event', async () => {
    const events: VoiceEvent[] = []
    const out = await handleTurn('hi', [], fakeDeps(events, [
      { type: 'text-delta', text: 'Hello Tony.' }
    ]) as never)

    expect(events.some(e => e.type === 'usage')).toBe(false)
    const last = out[out.length - 1] as { role: string; content: string }
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('Hello Tony.')
  })
})
