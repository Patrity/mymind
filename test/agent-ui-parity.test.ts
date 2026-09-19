// Drift guard: the SAME turn, (a) streamed live through orchestrator → turn stream → client
// assembly, and (b) persisted → resumed through toUIMessages, must render the same parts.
// Reasoning is compared by content only: live it can interleave with tools, persisted it is
// one string (a documented asymmetry).
import { describe, it, expect } from 'vitest'
import { handleTurn, type VoiceEvent } from '../server/lib/voice/orchestrator'
import { createTurnStream } from '../server/lib/voice/turn-stream'
import { buildTurnPersistPayload } from '../server/lib/voice/turn-persist'
import { createClientTurns } from '../app/lib/agent/turn-stream'
import { toUIMessages, type ResumeMessage } from '../app/lib/agent/to-ui-messages'
import type { AgentEvent } from '../server/lib/agent/run'
import type { AgentMessageFrame, AgentUIMessage } from '../shared/types/agent-ui'
import type { VoicePresetDTO } from '../shared/types/voice-presets'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, calibratedRefKey: null, refSource: null, starredSeeds: [], isDefault: true
}

const agentEvents: AgentEvent[] = [
  { type: 'reasoning-delta', text: 'Check docs, then research.' },
  { type: 'text-delta', text: 'Looking. ' },
  { type: 'tool-start', name: 'search_docs', args: { q: 'orpheus' }, callId: 'c1' },
  { type: 'tool-result', name: 'search_docs', summary: 'found 2', callId: 'c1', args: { q: 'orpheus' }, result: { hits: 2 }, kind: 'read' },
  { type: 'tool-start', name: 'research_web', args: { task: 'orpheus tts' }, callId: 'c2' },
  { type: 'subagent-event', parentCallId: 'c2', event: { type: 'tool-start', name: 'web_search', args: {}, callId: 'n1' } },
  { type: 'subagent-event', parentCallId: 'c2', event: { type: 'tool-result', name: 'web_search', summary: 'searched (5)', callId: 'n1', result: { hits: 5 } } },
  { type: 'tool-result', name: 'research_web', summary: 'research: orpheus tts (1 tool calls)', callId: 'c2', args: { task: 'orpheus tts' }, result: { report: 'R' }, kind: 'read' },
  { type: 'tool-start', name: 'exec', args: { command: 'ls' }, callId: 'c3' },
  { type: 'tool-result', name: 'exec', summary: 'denied: exec', callId: 'c3', args: { command: 'ls' }, result: { denied: true }, kind: 'destructive' },
  { type: 'text-delta', text: 'Found two notes and a report.' },
  { type: 'usage', inputTokens: 100, outputTokens: 20, totalTokens: 120 }
]

function shape(m: AgentUIMessage) {
  return {
    role: m.role,
    reasoning: m.parts.filter(p => p.type === 'reasoning').map(p => (p as { text: string }).text).join(''),
    usage: m.metadata?.usage,
    parts: m.parts.filter(p => p.type !== 'step-start' && p.type !== 'reasoning').map((p) => {
      if (p.type === 'text') return { text: p.text }
      if (p.type === 'dynamic-tool') return { tool: p.toolName, id: p.toolCallId, state: p.state, input: p.input, output: 'output' in p ? p.output : undefined, errorText: 'errorText' in p ? p.errorText : undefined }
      if (p.type === 'data-subagent') return { subagent: p.data.steps }
      return { other: p.type }
    })
  }
}

describe('live ↔ resume parity', () => {
  it('a turn renders the same live and after resume', async () => {
    // (a) live
    const frames: AgentMessageFrame[] = []
    const ts = createTurnStream({ turnId: 1, send: d => { if (typeof d === 'string') { const f = JSON.parse(d); if (f.type === 'chunk' || f.type === 'user-message') frames.push(f) } } })
    let reasoning = ''
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null = null
    const out = await handleTurn('find orpheus', [], {
      tts: { async *synthesize() {} } as never, preset, signal: new AbortController().signal, speak: false,
      emit: (e: VoiceEvent) => {
        if (e.type === 'reasoning') reasoning += e.text
        else if (e.type === 'usage') usage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens, totalTokens: e.totalTokens }
        ts.emit(e)
      },
      async *runAgent() { for (const e of agentEvents) yield e }
    })
    ts.finish()
    const live: AgentUIMessage[] = []
    const turns = createClientTurns({ upsert: (m) => { const i = live.findIndex(x => x.id === m.id); if (i >= 0) live[i] = m; else live.push(m) } })
    for (const f of frames) turns.handle(f)
    await turns.settled()

    // (b) persisted → resumed
    const persisted = buildTurnPersistPayload(out, { inputModality: 'text', speakFlag: false, attachments: [], reasoning, usage })
    const resumed = toUIMessages(persisted.map((p, i): ResumeMessage => ({
      id: `r${i}`, role: p.role, content: p.content,
      toolCalls: (p.toolCalls ?? null) as ResumeMessage['toolCalls'],
      reasoning: p.reasoning, attachments: p.attachments, usage: p.usage
    })))

    expect(live.map(shape)).toEqual(resumed.map(shape))
    // and the parity is not vacuous: the interesting parts are really there
    const tools = shape(live[1]!).parts.filter(p => 'tool' in p)
    expect(tools.map(t => (t as { state: string }).state)).toEqual(['output-available', 'output-available', 'output-denied'])
    expect(shape(live[1]!).parts.some(p => 'subagent' in p)).toBe(true)
  })
})
