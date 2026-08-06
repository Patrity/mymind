// test/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { handleUtterance, handleTurn } from '../server/lib/voice/orchestrator'

const stt = { transcribe: vi.fn(async () => 'what are my tasks') }
const tts = { synthesize: vi.fn(async function* () { yield new Uint8Array([9]) }) }
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
      stt, tts, voice: 'af_heart', speak: true, runAgent, signal: new AbortController().signal,
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
      stt: coldStt, tts, voice: 'af_heart', speak: true, runAgent, signal: ac.signal,
      emit: () => {}
    })
    expect(coldStt.transcribe).not.toHaveBeenCalled()
    expect(out).toBe(history)
  })

  it('emits state:tool on tool-start and returns to thinking on tool-result', async () => {
    const events: any[] = []
    await handleUtterance(new Uint8Array([1]), [], {
      stt, tts, voice: 'af_heart', speak: true, runAgent: runAgentWithTool, signal: new AbortController().signal,
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
      tts, voice: 'af_heart', speak: true, runAgent, signal: new AbortController().signal,
      emit: e => events.push(e)
    })
    expect(events.find(e => e.type === 'transcript' && e.role === 'user')?.text).toBe('what are my tasks')
    expect(events.filter(e => e.type === 'state').map(e => e.state)).toContain('thinking')
    expect(events.some(e => e.type === 'audio')).toBe(true)
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'You have two tasks.' })
  })

  it('empty text is a no-op', async () => {
    const events: any[] = []
    const history = await handleTurn('', [{ role: 'user', content: 'hi' }], {
      tts, voice: 'af_heart', speak: true, runAgent, signal: new AbortController().signal,
      emit: e => events.push(e)
    })
    expect(events).toEqual([])
    expect(history).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('emits a reasoning event, keeps it out of TTS and out of the persisted answer', async () => {
    const events: any[] = []
    const reasoningTts = { synthesize: vi.fn(async function* () { yield new Uint8Array([1]) }) }
    const runReason = (async function* () {
      yield { type: 'reasoning-delta', text: 'thinking… ' }
      yield { type: 'text-delta', text: 'Final answer.' }
      yield { type: 'done' }
    }) as never
    const history = await handleTurn('hi', [], {
      tts: reasoningTts, voice: 'af_heart', speak: true, runAgent: runReason,
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
      tts, voice: 'af_heart', speak: false, runAgent: runTools,
      signal: new AbortController().signal, emit: e => events.push(e)
    })

    const assistant = history.at(-1) as { toolRecords?: { callId: string; textOffset: number }[] }
    expect(assistant.toolRecords).toHaveLength(1)
    expect(assistant.toolRecords![0]!.callId).toBe('c1')
    expect(assistant.toolRecords![0]!.textOffset).toBe('Looking. '.length)
  })

  it('omits toolRecords entirely when no tool ran', async () => {
    const events: any[] = []
    const runPlain = (async function* () {
      yield { type: 'text-delta', text: 'just chat' }
      yield { type: 'done' }
    }) as never
    const history = await handleTurn('hi', [], {
      tts, voice: 'af_heart', speak: false, runAgent: runPlain,
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
      tts, voice: 'af_heart', speak: false, runAgent: runBig,
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
      tts, voice: 'af_heart', speak: false, runAgent: runWrite,
      signal: new AbortController().signal, emit: e => events.push(e)
    })

    const rec = (history.at(-1) as { toolRecords: { args: Record<string, unknown> }[] }).toolRecords[0]!
    expect(JSON.stringify(rec.args)).not.toContain(body)
    expect(JSON.stringify(rec.args).length).toBeLessThan(6000)
  })
})
