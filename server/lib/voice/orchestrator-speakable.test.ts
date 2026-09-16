// server/lib/voice/orchestrator-speakable.test.ts
import { describe, it, expect } from 'vitest'
import { handleTurn } from './orchestrator'
import type { AgentEvent } from '../agent/run'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, calibratedRefKey: null, starredSeeds: [], isDefault: true
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

/** The non-tts half of TurnDeps, shared by the chain tests below. */
function chainDeps() {
  return { signal: new AbortController().signal, emit: () => {} }
}

describe('handleTurn — voice chain', () => {
  const RATE = 24000
  /** Enough PCM to clear MIN_CHAIN_REFERENCE_MS. */
  const speechChunk = () => new Uint8Array(RATE * 2 * 3)

  /** Captures what each synthesize() call was actually asked to speak with. */
  function recordingTts() {
    const calls: { text: string; refBytes: number; refText: string | null; instruction: string | null; cfg: number }[] = []
    const tts = {
      async *synthesize(text: string, opts: { preset: VoicePresetDTO; refAudio?: Uint8Array | null }) {
        calls.push({
          text,
          refBytes: opts.refAudio?.length ?? 0,
          refText: opts.preset.refText,
          instruction: opts.preset.instruction,
          cfg: opts.preset.cfgScale,
        })
        yield { kind: 'begin' as const, sampleRate: RATE }
        yield { kind: 'pcm' as const, bytes: speechChunk() }
      }
    }
    return { tts, calls }
  }

  const longReply = [
    'The rig has five graphics cards and about a hundred and ninety gigabytes of video memory available today. ',
    'Most of that capacity is taken up by the language model, which still leaves plenty for the voice stack. ',
    'Breeze now runs on a card of its own, so nothing else competes with it for memory or for compute time. ',
  ]

  it('anchors every segment after the first to the first segment audio', async () => {
    const { tts, calls } = recordingTts()
    await handleTurn('hi', [], {
      ...chainDeps(), tts: tts as never, preset, speak: true,
      runAgent: async function* () { for (const t of longReply) yield { type: 'text-delta' as const, text: t } },
    })

    expect(calls.length).toBeGreaterThan(1)
    // Segment one renders exactly as before — no reference, so it goes out the moment the
    // first words arrive.
    expect(calls[0]!.refBytes).toBe(0)
    // Every later segment carries the chain.
    for (const c of calls.slice(1)) {
      expect(c.refBytes).toBeGreaterThan(0)
      expect(c.refText).toBe(calls[0]!.text)
    }
  })

  // Measured: keeping the instruction (direction, cfg 4) held the spread to 19.2 Hz;
  // dropping it for a plain clone was 38.9 Hz. The description and the clip anchor together.
  it('keeps the instruction and cfg on chained segments', async () => {
    const { tts, calls } = recordingTts()
    await handleTurn('hi', [], {
      ...chainDeps(), tts: tts as never, preset, speak: true,
      runAgent: async function* () { for (const t of longReply) yield { type: 'text-delta' as const, text: t } },
    })
    for (const c of calls.slice(1)) {
      expect(c.instruction).toBe(preset.instruction)
      expect(c.cfg).toBe(preset.cfgScale)
    }
  })

  // A preset with a chosen clip anchors better than a synthetic first segment (14.7 vs
  // 19.2 Hz measured), so chaining must not override it.
  it('leaves a preset that brings its own reference unchained', async () => {
    const { tts, calls } = recordingTts()
    const stored = new Uint8Array([7, 7, 7])
    await handleTurn('hi', [], {
      ...chainDeps(), tts: tts as never, speak: true,
      preset: { ...preset, refStorageKey: 'stored', refText: 'its own transcript' },
      refAudio: stored,
      runAgent: async function* () { for (const t of longReply) yield { type: 'text-delta' as const, text: t } },
    })
    for (const c of calls) {
      expect(c.refBytes).toBe(stored.length)
      expect(c.refText).toBe('its own transcript')
    }
  })

  it('does not chain a single-segment turn — there is nothing after the first', async () => {
    const { tts, calls } = recordingTts()
    await handleTurn('hi', [], {
      ...chainDeps(), tts: tts as never, preset, speak: true,
      runAgent: async function* () { yield { type: 'text-delta' as const, text: 'Short reply.' } },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.refBytes).toBe(0)
  })
})
