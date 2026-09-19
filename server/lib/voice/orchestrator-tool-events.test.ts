import { describe, it, expect } from 'vitest'
import { handleTurn, type VoiceEvent } from './orchestrator'
import type { AgentEvent } from '../agent/run'
import type { NestedToolEvent } from '../agent/types'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'
import { ARGS_WRITE_CAP } from '../agent/tool-history'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, calibratedRefKey: null, refSource: null, starredSeeds: [], isDefault: true
}

async function run(agentEvents: AgentEvent[]) {
  const events: VoiceEvent[] = []
  const out = await handleTurn('research orpheus', [], {
    tts: { async *synthesize() {} } as never, preset, signal: new AbortController().signal, speak: false,
    emit: e => { events.push(e) },
    async *runAgent() { for (const e of agentEvents) yield e }
  })
  return { events, out }
}

const nested = (event: NestedToolEvent): AgentEvent => ({ type: 'subagent-event', parentCallId: 'c1', event })

describe('handleTurn tool lifecycle events', () => {
  it('emits tool-start with the callId and CAPPED args', async () => {
    const big = { content: 'x'.repeat(ARGS_WRITE_CAP * 2) }
    const { events } = await run([{ type: 'tool-start', name: 'save_document', args: big, callId: 'c1' }])
    const start = events.find(e => e.type === 'tool-start') as Extract<VoiceEvent, { type: 'tool-start' }>
    expect(start).toMatchObject({ callId: 'c1', name: 'save_document' })
    expect(start.args).toMatchObject({ truncated: true })
  })

  it('emits the tool result with the same capped args/result it persists', async () => {
    const { events, out } = await run([
      { type: 'tool-start', name: 'search_docs', args: { q: 'a' }, callId: 'c1' },
      { type: 'tool-result', name: 'search_docs', summary: 'found 2', callId: 'c1', args: { q: 'a' }, result: { hits: 2 }, kind: 'read' }
    ])
    const tool = events.find(e => e.type === 'tool') as Extract<VoiceEvent, { type: 'tool' }>
    expect(tool).toMatchObject({ callId: 'c1', name: 'search_docs', summary: 'found 2', args: { q: 'a' }, result: { hits: 2 }, kind: 'read' })
    const record = (out.at(-1) as { toolRecords?: unknown[] } | undefined)?.toolRecords
    expect(record).toBeUndefined() // no assistant text → no assistant message (existing rule)
  })

  it('accumulates subagent steps, emits the full list each time, and persists terminal states', async () => {
    const { events, out } = await run([
      { type: 'tool-start', name: 'research_web', args: { task: 't' }, callId: 'c1' },
      nested({ type: 'tool-start', name: 'web_search', args: { q: 'a' }, callId: 'n1' }),
      nested({ type: 'tool-result', name: 'web_search', summary: 'searched (3)', callId: 'n1', result: { hits: 3 } }),
      nested({ type: 'tool-start', name: 'web_fetch', args: { url: 'u' }, callId: 'n2' }),
      nested({ type: 'tool-result', name: 'web_fetch', summary: 'failed: web_fetch', callId: 'n2', result: { error: '403' } }),
      nested({ type: 'tool-start', name: 'web_fetch', args: { url: 'v' }, callId: 'n3' }),
      { type: 'tool-result', name: 'research_web', summary: 'research: t (2 tool calls)', callId: 'c1', args: { task: 't' }, result: { report: 'r' }, kind: 'read' },
      { type: 'text-delta', text: 'Done.' }
    ])
    const sub = events.filter(e => e.type === 'subagent') as Extract<VoiceEvent, { type: 'subagent' }>[]
    expect(sub).toHaveLength(5)
    expect(sub[0]).toEqual({ type: 'subagent', parentCallId: 'c1', steps: [{ callId: 'n1', name: 'web_search', state: 'running' }] })
    expect(sub[4]!.steps).toEqual([
      { callId: 'n1', name: 'web_search', summary: 'searched (3)', state: 'done' },
      { callId: 'n2', name: 'web_fetch', summary: 'failed: web_fetch', state: 'error' },
      { callId: 'n3', name: 'web_fetch', state: 'running' }
    ])
    const assistant = out.at(-1) as { role: string; toolRecords?: { steps?: unknown }[] }
    expect(assistant.role).toBe('assistant')
    expect(assistant.toolRecords![0]!.steps).toEqual([
      { callId: 'n1', name: 'web_search', summary: 'searched (3)', state: 'done' },
      { callId: 'n2', name: 'web_fetch', summary: 'failed: web_fetch', state: 'error' },
      { callId: 'n3', name: 'web_fetch', state: 'error' } // never finished → not left "running" forever
    ])
  })
})
