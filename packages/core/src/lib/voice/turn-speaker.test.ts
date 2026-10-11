// Cycle 81: the turn's speech path, moved out of the orchestrator (TTS now runs in the web's voice
// socket). These are the orchestrator's former TTS tests — orchestrator-speakable.test.ts's synth
// text checks and test/orchestrator.test.ts's audio pairing — driven through createTurnSpeaker.
import { describe, it, expect, vi } from 'vitest'
import { createTurnSpeaker, type SpeakerEvent } from './turn-speaker'
import type { VoicePresetDTO } from '../../shared/types/voice-presets'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, calibratedRefKey: null, refSource: null, starredSeeds: [], isDefault: true
}

function speakerFor(synthesize: (text: string) => AsyncIterable<{ kind: 'begin'; sampleRate: number } | { kind: 'pcm'; bytes: Uint8Array }>, signal = new AbortController().signal) {
  const events: SpeakerEvent[] = []
  const sp = createTurnSpeaker({ synthesize: synthesize as never, preset, signal, emit: e => events.push(e) })
  return { sp, events }
}

const recordingSynth = (spoken: string[]) => async function* (text: string) {
  spoken.push(text)
  yield { kind: 'begin' as const, sampleRate: 24000 }
  yield { kind: 'pcm' as const, bytes: new Uint8Array([1]) }
}

describe('createTurnSpeaker', () => {
  it('speaks sanitized text and never sends markdown to the synth', async () => {
    const spoken: string[] = []
    const { sp } = speakerFor(recordingSynth(spoken))
    await sp.push('Here are your **6 ')
    await sp.push('projects**. The rig is at 192.168.2.25 today. ')
    await sp.finish()
    expect(spoken.join(' ')).not.toContain('*')
    expect(spoken.join(' ')).toContain('6 projects')
  })

  it('does not fragment an IP address into separate synth calls', async () => {
    const spoken: string[] = []
    const { sp } = speakerFor(recordingSynth(spoken))
    await sp.push('Here are your **6 ')
    await sp.push('projects**. The rig is at 192.168.2.25 today. ')
    await sp.finish()
    expect(spoken.filter(s => s.includes('dot'))).toHaveLength(1)
  })

  it('emits speaking, then a sample-rate-carrying audio-begin, PCM and audio-end per segment', async () => {
    const { sp, events } = speakerFor(recordingSynth([]))
    await sp.push('You have two tasks.')
    await sp.finish()
    expect(events.map(e => e.type)).toEqual(['speaking', 'audio-begin', 'audio', 'audio-end'])
    expect(events[1]).toEqual({ type: 'audio-begin', segmentId: 1, sampleRate: 24000 })
  })

  it('pairs audio-begin/audio-end per segment and stays silent for a segment that was dropped', async () => {
    // A segment whose synthesis throws before yielding anything must emit NEITHER frame. The
    // ordering is deliberate: drop, speak, drop, speak — only a drop that FOLLOWS a successful
    // segment exposes a missing open-segment guard (segmentId still names its predecessor).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let call = 0
    const synth = vi.fn(async function* () {
      call++
      if (call % 2 === 1) throw new Error('truncated')
      yield { kind: 'begin' as const, sampleRate: 24000 }
      yield { kind: 'pcm' as const, bytes: new Uint8Array([7]) }
    })
    const { sp, events } = speakerFor(synth)
    // The orchestrator test's exact deltas (four segments).
    for (const s of ['First', 'Second', 'Third', 'Fourth']) await sp.push(`${s} sentence here. `)
    await sp.finish()
    expect(synth).toHaveBeenCalledTimes(4)
    const audio = events.filter(e => e.type === 'audio-begin' || e.type === 'audio-end')
    expect(audio.map(e => e.type)).toEqual(['audio-begin', 'audio-end', 'audio-begin', 'audio-end'])
    expect(audio.map(e => (e as { segmentId: number }).segmentId)).toEqual([1, 1, 2, 2])
    errSpy.mockRestore()
  })

  it('an aborted signal stops it: nothing more is synthesized', async () => {
    const spoken: string[] = []
    const ac = new AbortController()
    const { sp } = speakerFor(recordingSynth(spoken), ac.signal)
    ac.abort()
    await sp.push('You have two tasks. ')
    await sp.finish()
    expect(spoken).toEqual([])
  })
})
