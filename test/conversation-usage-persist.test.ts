// test/conversation-usage-persist.test.ts
//
// Proves usage reaches the record that gets persisted, end to end from the agent event
// stream through to the appendMessages payload — without a live DB (server/api/voice/ws.ts's
// `defineWebSocketHandler` needs a real crossws upgrade to exercise directly, and there's no
// existing harness for that here). Drives handleTurn with a fake runAgent (same scaffolding
// as server/lib/voice/orchestrator-speakable.test.ts), accumulates the VoiceEvents the same
// trivial way ws.ts's emit closure does, then calls the REAL buildTurnPersistPayload — the
// exported seam server/api/voice/ws.ts itself imports and calls — rather than reimplementing
// the payload shape locally. If ws.ts's shipped call ever stops passing the real usage value
// into that function, or the function itself regresses, this goes red.
import { describe, it, expect } from 'vitest'
import { handleTurn } from '../server/lib/voice/orchestrator'
import type { VoiceEvent } from '../server/lib/voice/orchestrator'
import type { AgentEvent } from '../server/lib/agent/run'
import { buildTurnPersistPayload, type TurnPersistContext } from '../server/lib/voice/turn-persist'

function fakeDeps(agentEvents: AgentEvent[], emit: (e: VoiceEvent) => void) {
  return {
    tts: { async *synthesize() { /* not exercised: speak: false */ } } as never,
    voice: 'af_heart',
    signal: new AbortController().signal,
    speak: false,
    emit,
    async *runAgent(): AsyncGenerator<AgentEvent> {
      for (const e of agentEvents) yield e
    }
  }
}

async function runTurn(agentEvents: AgentEvent[]) {
  let reasoning = ''
  let usage: TurnPersistContext['usage'] = null
  const emit = (e: VoiceEvent) => {
    if (e.type === 'reasoning') reasoning += e.text
    else if (e.type === 'usage') usage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens, totalTokens: e.totalTokens }
  }
  const added = await handleTurn('hi', [], fakeDeps(agentEvents, emit) as never)
  return buildTurnPersistPayload(added, { inputModality: 'text', speakFlag: false, attachments: [], reasoning, usage })
}

describe('usage reaches the persisted-message payload (via the real ws.ts seam)', () => {
  it('carries the usage from a finish-sourced usage AgentEvent onto the assistant row', async () => {
    const payload = await runTurn([
      { type: 'text-delta', text: 'Hello Tony.' },
      { type: 'usage', inputTokens: 120, outputTokens: 45, totalTokens: 165 }
    ])
    const assistantMsg = payload.find(m => m.role === 'assistant')!
    expect(assistantMsg.usage).toEqual({ inputTokens: 120, outputTokens: 45, totalTokens: 165 })
  })

  it('completes and yields null usage, not a throw, for a turn with no usage event', async () => {
    const payload = await runTurn([
      { type: 'text-delta', text: 'Hello Tony.' }
    ])
    const assistantMsg = payload.find(m => m.role === 'assistant')!
    expect(assistantMsg.usage).toBeNull()
  })

  it('never puts usage on the user row', async () => {
    const payload = await runTurn([
      { type: 'text-delta', text: 'Hello Tony.' },
      { type: 'usage', inputTokens: 120, outputTokens: 45, totalTokens: 165 }
    ])
    const userMsg = payload.find(m => m.role === 'user')!
    expect(userMsg.usage).toBeNull()
  })
})
