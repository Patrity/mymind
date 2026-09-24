// test/agent-memory-context.test.ts
import { describe, it, expect } from 'vitest'
import { handleTurn } from '../server/lib/voice/orchestrator'
import type { VoicePresetDTO } from '../shared/types/voice-presets'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, isDefault: true
}

describe('handleTurn memory injection', () => {
  it('appends the memory block to the context passed to runAgent', async () => {
    let seenContext: string | undefined
    const runAgent = (async function* (_m: unknown, ctx: { context?: string }) {
      seenContext = ctx.context
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'done' }
    }) as never
    await handleTurn('what do you know about my RAM', [], {
      tts: { synthesize: async function* () {} }, preset, speak: false,
      context: 'Current context: open tasks…',
      buildMemoryContext: async () => 'Possibly relevant memories:\n- Tony has 656GB of DDR4',
      runAgent, signal: new AbortController().signal, emit: () => {}
    })
    expect(seenContext).toContain('Current context: open tasks…')
    expect(seenContext).toContain('Tony has 656GB of DDR4')
  })

  it('passes the base context unchanged when no memories are found', async () => {
    let seenContext: string | undefined
    const runAgent = (async function* (_m: unknown, ctx: { context?: string }) {
      seenContext = ctx.context
      yield { type: 'done' }
    }) as never
    await handleTurn('hello', [], {
      tts: { synthesize: async function* () {} }, preset, speak: false,
      context: 'Current context: X',
      buildMemoryContext: async () => '',
      runAgent, signal: new AbortController().signal, emit: () => {}
    })
    expect(seenContext).toBe('Current context: X')
  })
})
