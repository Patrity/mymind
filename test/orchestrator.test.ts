// test/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { handleUtterance, handleTurn } from '../server/lib/voice/orchestrator'
import { resolveTurnVoice, FALLBACK_PRESET } from '../server/services/voice-presets'
import type { VoicePresetDTO } from '../shared/types/voice-presets'

const preset: VoicePresetDTO = {
  id: 'p1', name: 'n', instruction: 'A calm man.', cfgScale: 4, seed: 11, temperature: 0.9,
  topP: 1, topK: 50, refStorageKey: null, refText: null, refDurationMs: null,
  maxSegmentChars: 200, isDefault: true
}

const stt = { transcribe: vi.fn(async () => 'what are my tasks') }
const tts = { synthesize: vi.fn(async function* () {
  yield { kind: 'begin' as const, sampleRate: 24000 }
  yield { kind: 'pcm' as const, bytes: new Uint8Array([9]) }
}) }
const runAgent = (async function* () {
  yield { type: 'text-delta', text: 'You have ' }
  yield { type: 'tool-result', name: 'search_tasks', summary: 'listed tasks (2)', undoToken: undefined }
  yield { type: 'text-delta', text: 'two tasks.' }
  yield { type: 'done' }
}) as never

const runAgentWithTool = (async function* () {
  yield { type: 'text-delta', text: 'Let me check. ' }
  yield { type: 'tool-start', name: 'search_tasks', args: {} }
  yield { type: 'tool-result', name: 'search_tasks', summary: 'listed tasks (2)', undoToken: undefined }
  yield { type: 'text-delta', text: 'You have two tasks.' }
  yield { type: 'done' }
}) as never

describe('handleUtterance', () => {
  it('STT -> runAgent -> chunked TTS, emitting transcript/tool/audio events', async () => {
    const events: any[] = []
    await handleUtterance(new Uint8Array([1]), [], {
      stt, tts, preset, speak: true, runAgent, signal: new AbortController().signal,
      emit: e => events.push(e)
    })
    expect(events.find(e => e.type === 'transcript' && e.role === 'user')?.text).toBe('what are my tasks')
    expect(events.some(e => e.type === 'tool' && e.name === 'search_tasks')).toBe(true)
    expect(events.some(e => e.type === 'audio')).toBe(true)
    expect(stt.transcribe).toHaveBeenCalledOnce()
  })

  // Turns queue behind the connection lock (ws.ts), but the AbortController is fired the
  // instant the NEXT frame lands — so a queued turn can reach STT with an already-dead
  // signal (prod showed 0ms/2ms transcribe attempts). Don't dial the provider at all.
  it('skips STT entirely when the turn was already cancelled before it got the lock', async () => {
    const ac = new AbortController()
    ac.abort()
    const coldStt = { transcribe: vi.fn(async () => 'should never run') }
    const history = [{ role: 'user' as const, content: 'earlier turn' }]
    const out = await handleUtterance(new Uint8Array([1]), history, {
      stt: coldStt, tts, preset, speak: true, runAgent, signal: ac.signal,
      emit: () => {}
    })
    expect(coldStt.transcribe).not.toHaveBeenCalled()
    expect(out).toBe(history)
  })

  it('emits state:tool on tool-start and returns to thinking on tool-result', async () => {
    const events: any[] = []
    await handleUtterance(new Uint8Array([1]), [], {
      stt, tts, preset, speak: true, runAgent: runAgentWithTool, signal: new AbortController().signal,
      emit: e => events.push(e)
    })
    const states = events.filter(e => e.type === 'state').map(e => e.state)
    const toolIdx = states.indexOf('tool')
    expect(toolIdx).toBeGreaterThan(-1)
    expect(states[toolIdx + 1]).toBe('thinking')
    // the tool chip event still flows
    expect(events.some(e => e.type === 'tool' && e.name === 'search_tasks')).toBe(true)
  })
})

describe('handleTurn (typed input, post-STT injection)', () => {
  it('runs the full voice loop for typed text without touching STT', async () => {
    const events: any[] = []
    const freshStt = { transcribe: vi.fn(async () => 'never') }
    void freshStt // typed turns have no stt dep at all — compile-time guarantee
    const history = await handleTurn('what are my tasks', [], {
      tts, preset, speak: true, runAgent, signal: new AbortController().signal,
      emit: e => events.push(e)
    })
    expect(events.find(e => e.type === 'transcript' && e.role === 'user')?.text).toBe('what are my tasks')
    expect(events.filter(e => e.type === 'state').map(e => e.state)).toContain('thinking')
    expect(events.some(e => e.type === 'audio')).toBe(true)
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'You have two tasks.' })
  })

  it('pairs audio-begin/audio-end per segment and stays silent for a segment that was dropped', async () => {
    // A segment whose synthesis throws before yielding anything must emit NEITHER frame.
    // SpeechPipeline fires onSegmentEnd unconditionally (it owns segment lifetimes, not
    // frame semantics), and at that moment `segmentId` still holds the PREVIOUS segment's
    // value — so without the orchestrator's open-segment guard, a drop closes its
    // predecessor a SECOND time, naming an id that really did begin. That is a frame
    // reporting an end that never happened.
    //
    // The ordering here is deliberate: drop, speak, drop, speak. A turn whose FIRST
    // segment drops does NOT discriminate — at that point segmentId is still 0, so a bare
    // `segmentId > 0` check already suppresses the frame. Only a drop that FOLLOWS a
    // successful segment exposes the defect, so the run must contain both.
    const events: { type: string; segmentId?: number }[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let call = 0
    const flakyTts = { synthesize: vi.fn(async function* () {
      call++
      if (call % 2 === 1) throw new Error('truncated')          // segments 1 and 3: dropped
      yield { kind: 'begin' as const, sampleRate: 24000 }        // segments 2 and 4: speak
      yield { kind: 'pcm' as const, bytes: new Uint8Array([7]) }
    }) }
    const runFourSegments = (async function* () {
      yield { type: 'text-delta', text: 'First sentence here. ' }
      yield { type: 'text-delta', text: 'Second sentence here. ' }
      yield { type: 'text-delta', text: 'Third sentence here. ' }
      yield { type: 'text-delta', text: 'Fourth sentence here. ' }
      yield { type: 'done' }
    }) as never

    await handleTurn('hi', [], {
      tts: flakyTts, preset, speak: true, runAgent: runFourSegments,
      signal: new AbortController().signal, emit: e => events.push(e)
    })

    expect(flakyTts.synthesize).toHaveBeenCalledTimes(4)   // all four segments were attempted…
    const begins = events.filter(e => e.type === 'audio-begin')
    const ends = events.filter(e => e.type === 'audio-end')
    expect(begins).toHaveLength(2)                         // …only the two that spoke opened…
    expect(ends).toHaveLength(2)                           // …and exactly those two closed.
    expect(ends.map(e => e.segmentId)).toEqual(begins.map(e => e.segmentId))
    // Strictly alternating, so no audio-end ever precedes its audio-begin and no segment
    // is closed twice. Drop the orchestrator's open-segment guard and segment 3's drop
    // inserts a spurious second 'audio-end' for segment 1 right here.
    expect(events.filter(e => e.type.startsWith('audio-')).map(e => e.type))
      .toEqual(['audio-begin', 'audio-end', 'audio-begin', 'audio-end'])
    errSpy.mockRestore()
  })

  it('empty text is a no-op', async () => {
    const events: any[] = []
    const history = await handleTurn('', [{ role: 'user', content: 'hi' }], {
      tts, preset, speak: true, runAgent, signal: new AbortController().signal,
      emit: e => events.push(e)
    })
    expect(events).toEqual([])
    expect(history).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('emits a reasoning event, keeps it out of TTS and out of the persisted answer', async () => {
    const events: any[] = []
    const reasoningTts = { synthesize: vi.fn(async function* () {
      yield { kind: 'begin' as const, sampleRate: 24000 }
      yield { kind: 'pcm' as const, bytes: new Uint8Array([1]) }
    }) }
    const runReason = (async function* () {
      yield { type: 'reasoning-delta', text: 'thinking… ' }
      yield { type: 'text-delta', text: 'Final answer.' }
      yield { type: 'done' }
    }) as never
    const history = await handleTurn('hi', [], {
      tts: reasoningTts, preset, speak: true, runAgent: runReason,
      signal: new AbortController().signal, emit: e => events.push(e)
    })
    // reasoning surfaced as its own event…
    expect(events.some(e => e.type === 'reasoning' && e.text === 'thinking… ')).toBe(true)
    // …never spoken (TTS only ever saw the answer text)…
    for (const call of reasoningTts.synthesize.mock.calls) {
      expect(call[0]).not.toContain('thinking')
    }
    // …and never merged into the persisted assistant content.
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'Final answer.' })
  })

  it('attaches tool records with the text offset at which each fired', async () => {
    const events: any[] = []
    const runTools = (async function* () {
      yield { type: 'text-delta', text: 'Looking. ' }
      yield { type: 'tool-result', name: 'web_search', summary: 's', callId: 'c1', args: { q: 'a' }, result: { hits: 1 }, kind: 'read' }
      yield { type: 'text-delta', text: 'Found it.' }
      yield { type: 'done' }
    }) as never
    const history = await handleTurn('hi', [], {
      tts, preset, speak: false, runAgent: runTools,
      signal: new AbortController().signal, emit: e => events.push(e)
    })

    const assistant = history.at(-1) as { toolRecords?: { callId: string; textOffset: number }[] }
    expect(assistant.toolRecords).toHaveLength(1)
    expect(assistant.toolRecords![0]!.callId).toBe('c1')
    expect(assistant.toolRecords![0]!.textOffset).toBe('Looking. '.length)
  })

  it('records an offset that indexes the PERSISTED text, not the raw stream', async () => {
    // The persisted content is applyImageEmbeds(assistantText).content, which trims and
    // collapses whitespace; a raw `assistantText.length` offset split the bubble mid-word
    // on resume ("Okay. D" | chip | "one.").
    const events: any[] = []
    const runSan = (async function* () {
      yield { type: 'text-delta', text: '\nOkay. ' }
      yield { type: 'tool-result', name: 'web_search', summary: 's', callId: 'c1', args: {}, result: {}, kind: 'read' }
      yield { type: 'text-delta', text: ' Done.' }
      yield { type: 'done' }
    }) as never
    const history = await handleTurn('hi', [], {
      tts, preset, speak: false, runAgent: runSan,
      signal: new AbortController().signal, emit: e => events.push(e)
    })

    const msg = history.at(-1) as { content: string; toolRecords: { textOffset: number }[] }
    expect(msg.content).toBe('Okay. Done.')
    const at = msg.toolRecords[0]!.textOffset
    expect(msg.content.slice(0, at)).toBe('Okay. ')
    expect(msg.content.slice(at)).toBe('Done.')
  })

  it('omits toolRecords entirely when no tool ran', async () => {
    const events: any[] = []
    const runPlain = (async function* () {
      yield { type: 'text-delta', text: 'just chat' }
      yield { type: 'done' }
    }) as never
    const history = await handleTurn('hi', [], {
      tts, preset, speak: false, runAgent: runPlain,
      signal: new AbortController().signal, emit: e => events.push(e)
    })
    expect((history.at(-1) as { toolRecords?: unknown[] }).toolRecords).toBeUndefined()
  })

  it('caps an oversized result at the write ceiling before it is ever stored', async () => {
    const events: any[] = []
    const runBig = (async function* () {
      yield { type: 'tool-result', name: 'web_fetch', summary: 's', callId: 'c1', args: {}, result: { body: 'z'.repeat(50_000) }, kind: 'read' }
      yield { type: 'text-delta', text: 'done' }
      yield { type: 'done' }
    }) as never
    const history = await handleTurn('hi', [], {
      tts, preset, speak: false, runAgent: runBig,
      signal: new AbortController().signal, emit: e => events.push(e)
    })

    const rec = (history.at(-1) as { toolRecords: { result: { truncated?: boolean } }[] }).toolRecords[0]!
    expect(rec.result.truncated).toBe(true)
    expect(JSON.stringify(rec.result).length).toBeLessThan(10_000)
  })

  it('caps oversized tool ARGS at the write ceiling before they are ever stored', async () => {
    // save_document's body used to be persisted raw and replayed on every later turn.
    const body = 'y'.repeat(60_000)
    const events: any[] = []
    const runWrite = (async function* () {
      yield { type: 'tool-result', name: 'save_document', summary: 's', callId: 'c1', args: { path: '/a.md', content: body }, result: { ok: true }, kind: 'create' }
      yield { type: 'text-delta', text: 'saved' }
      yield { type: 'done' }
    }) as never
    const history = await handleTurn('hi', [], {
      tts, preset, speak: false, runAgent: runWrite,
      signal: new AbortController().signal, emit: e => events.push(e)
    })

    const rec = (history.at(-1) as { toolRecords: { args: Record<string, unknown> }[] }).toolRecords[0]!
    expect(JSON.stringify(rec.args)).not.toContain(body)
    expect(JSON.stringify(rec.args).length).toBeLessThan(6000)
  })
})

// Voice state must never cost the user their answer. ws.ts resolves the preset and its
// reference clip INSIDE the turn closure, so anything that throws there propagates to the
// closure's catch and the user gets {type:'error'} + idle — losing the TEXT answer over a
// voice lookup. Before this cycle a typed turn with replies off touched no voice state at
// all; it now can, so every path has to degrade to "no audio", never to "no turn".
//
// These drive `resolveTurnVoice` — the exact seam ws.ts imports and calls — and then feed
// its output to the real handleTurn, mirroring the shipped call site rather than
// reimplementing it locally. (ws.ts's defineWebSocketHandler needs a real crossws upgrade
// to exercise directly; same constraint as test/conversation-usage-persist.test.ts.)
describe('turn voice resolution degrades, never fails the turn', () => {
  it('survives a dead database: still answers, in the hardcoded fallback voice', async () => {
    // Plain vitest boots no Nuxt, so `useRuntimeConfig` is undefined and `useDb()` throws.
    // This test therefore runs against a genuinely unreachable database — the real failure
    // mode — with no mocking of the service at all. getDefaultPreset() throws on a missing
    // seed row and on any transient DB error, and resolvePreset runs on EVERY spoken turn.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { preset: got, refAudio } = await resolveTurnVoice('a-stale-cookie-id', true)
    expect(got).toEqual(FALLBACK_PRESET)
    expect(refAudio).toBeNull()   // the fallback carries no clip, so no blob read to fail

    const events: any[] = []
    const history = await handleTurn('hi', [], {
      tts, preset: got, refAudio, speak: true, runAgent,
      signal: new AbortController().signal, emit: e => events.push(e)
    })
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'You have two tasks.' })
    expect(events.some(e => e.type === 'audio')).toBe(true)
    errSpy.mockRestore()
  })

  it('survives an unreadable reference clip: speaks without it rather than losing the turn', async () => {
    // loadReferenceBytes does a bare storage().get() — a deleted or unreadable blob throws.
    // A clone preset that loses its reference speaks as a design preset: it sounds wrong,
    // which is strictly better than the user getting nothing.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const clonePreset = { ...preset, refStorageKey: 'deleted-clip.wav', refText: 'hello' }
    const loadRef = vi.fn(async () => { throw new Error('NoSuchKey') })
    const { preset: got, refAudio } = await resolveTurnVoice('p1', true, {
      resolve: async () => clonePreset, loadRef
    })
    expect(loadRef).toHaveBeenCalledOnce()
    expect(got).toBe(clonePreset)   // still the voice the user picked…
    expect(refAudio).toBeNull()     // …just without the reference it could not read

    const history = await handleTurn('hi', [], {
      tts, preset: got, refAudio, speak: true, runAgent,
      signal: new AbortController().signal, emit: () => {}
    })
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'You have two tasks.' })
    errSpy.mockRestore()
  })

  it('a silent turn touches no voice state at all — no preset lookup, no blob read', async () => {
    const resolve = vi.fn(async () => preset)
    const loadRef = vi.fn(async () => null)
    const { preset: got, refAudio } = await resolveTurnVoice('p1', false, { resolve, loadRef })

    expect(resolve).not.toHaveBeenCalled()   // no DB round trip…
    expect(loadRef).not.toHaveBeenCalled()   // …and no storage round trip
    expect(got).toBe(FALLBACK_PRESET)        // only ever read for its maxSegmentChars
    expect(refAudio).toBeNull()

    const history = await handleTurn('hi', [], {
      tts, preset: got, refAudio, speak: false, runAgent,
      signal: new AbortController().signal, emit: () => {}
    })
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'You have two tasks.' })
  })
})
