// test/conversation-usage-persist.test.ts
//
// Proves usage reaches the record that gets persisted, end to end from the agent event
// stream through to the appendMessages payload — without a live DB (server/api/voice/ws.ts's
// `defineWebSocketHandler` needs a real crossws upgrade to exercise directly, and there's no
// existing harness for that here). This drives handleTurn with a fake runAgent (same
// scaffolding as server/lib/voice/orchestrator-speakable.test.ts), then reproduces the exact
// emit-closure accumulation + NewConvMessage payload that ws.ts's `run()` builds for
// appendMessages. server/services/conversations.ts's own tests (msgToDTO / appendMessages'
// insert) already cover that a NewConvMessage.usage value survives the DB round trip — this
// test is about proving the WS turn pipeline actually produces that value in the first place.
import { describe, it, expect } from 'vitest'
import { handleTurn } from '../server/lib/voice/orchestrator'
import type { VoiceEvent } from '../server/lib/voice/orchestrator'
import type { AgentEvent } from '../server/lib/agent/run'
import type { NewConvMessage } from '../server/services/conversations'

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

/** Mirrors server/api/voice/ws.ts's run(): accumulate usage/reasoning off VoiceEvents, then
 *  build the same appendMessages payload shape for the turn's added messages. */
async function buildPersistPayload(agentEvents: AgentEvent[]): Promise<NewConvMessage[]> {
  let reasoningText = ''
  let turnUsage: NewConvMessage['usage'] = null
  const emit = (e: VoiceEvent) => {
    if (e.type === 'reasoning') reasoningText += e.text
    else if (e.type === 'usage') turnUsage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens, totalTokens: e.totalTokens }
  }
  const history = await handleTurn('hi', [], fakeDeps(agentEvents, emit) as never)
  return history.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: typeof m.content === 'string' ? m.content : '',
    modality: 'text' as const,
    reasoning: m.role === 'assistant' ? (reasoningText || null) : null,
    usage: m.role === 'assistant' ? turnUsage : null
  }))
}

describe('usage reaches the persisted-message payload (ws.ts closure pattern)', () => {
  it('carries the usage from a finish-sourced usage AgentEvent onto the assistant row', async () => {
    const payload = await buildPersistPayload([
      { type: 'text-delta', text: 'Hello Tony.' },
      { type: 'usage', inputTokens: 120, outputTokens: 45, totalTokens: 165 }
    ])
    const assistantMsg = payload.find(m => m.role === 'assistant')!
    expect(assistantMsg.usage).toEqual({ inputTokens: 120, outputTokens: 45, totalTokens: 165 })
  })

  it('completes and yields null usage, not a throw, for a turn with no usage event', async () => {
    const payload = await buildPersistPayload([
      { type: 'text-delta', text: 'Hello Tony.' }
    ])
    const assistantMsg = payload.find(m => m.role === 'assistant')!
    expect(assistantMsg.usage).toBeNull()
  })
})
