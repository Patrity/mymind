// test/conversation-usage-persist.test.ts
//
// Proves the SEAM, not ws.ts's own wiring: that a 'usage' AgentEvent yielded during a turn
// (handleTurn drives a fake runAgent) survives into the REAL buildTurnPersistPayload's output —
// landing on the assistant row and never the user row — without a live DB
// (server/api/voice/ws.ts's `defineWebSocketHandler` needs a real crossws upgrade to exercise
// directly, and there's no existing harness for that here). It reimplements ws.ts's
// emit-accumulation by hand, the same trivial pattern ws.ts's own `emit` closure uses, then
// calls buildTurnPersistPayload directly with the result — the exported function
// server/api/voice/ws.ts itself imports and calls, so a regression in THAT function is caught
// here. It does NOT execute server/api/voice/ws.ts's own code, so it CANNOT catch a regression
// in ws.ts's own call site — e.g. it would not notice ws.ts reverting to `usage: turnUsage`
// instead of the timing-merged value cycle 68 added, or dropping the call to
// buildTurnPersistPayload altogether.
import { describe, it, expect } from 'vitest'
import { handleTurn } from '../server/lib/voice/orchestrator'
import type { VoiceEvent } from '../server/lib/voice/orchestrator'
import type { AgentEvent } from '../server/lib/agent/run'
import { buildTurnPersistPayload, type TurnPersistContext } from '../server/lib/voice/turn-persist'
import type { VoicePresetDTO } from '../shared/types/voice-presets'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, isDefault: true
}

function fakeDeps(agentEvents: AgentEvent[], emit: (e: VoiceEvent) => void) {
  return {
    tts: { async *synthesize() { /* not exercised: speak: false */ } } as never,
    preset,
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

  it('passes a null usage straight through onto the assistant row without throwing', async () => {
    // This is buildTurnPersistPayload's OWN contract (its `usage` param accepts null) — not a
    // reproduction of today's ws.ts. Since cycle 68's turn-timing change, ws.ts always builds
    // at least `{ startedAt, durationMs }` before calling this (see buildUsageWithTiming in
    // server/api/voice/ws.ts), so a live turn no longer reaches this function with a null
    // usage even when the agent yielded no 'usage' event. Kept as a direct test of the
    // function's own null handling, which other callers may still rely on.
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
