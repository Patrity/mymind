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
      stt, tts, voice: 'af_heart', runAgent, signal: new AbortController().signal,
      emit: e => events.push(e)
    })
    expect(events.find(e => e.type === 'transcript' && e.role === 'user')?.text).toBe('what are my tasks')
    expect(events.some(e => e.type === 'tool' && e.name === 'search_tasks')).toBe(true)
    expect(events.some(e => e.type === 'audio')).toBe(true)
    expect(stt.transcribe).toHaveBeenCalledOnce()
  })

  it('emits state:tool on tool-start and returns to thinking on tool-result', async () => {
    const events: any[] = []
    await handleUtterance(new Uint8Array([1]), [], {
      stt, tts, voice: 'af_heart', runAgent: runAgentWithTool, signal: new AbortController().signal,
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
      tts, voice: 'af_heart', runAgent, signal: new AbortController().signal,
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
      tts, voice: 'af_heart', runAgent, signal: new AbortController().signal,
      emit: e => events.push(e)
    })
    expect(events).toEqual([])
    expect(history).toEqual([{ role: 'user', content: 'hi' }])
  })
})
