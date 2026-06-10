// test/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { handleUtterance } from '../server/lib/voice/orchestrator'

const stt = { transcribe: vi.fn(async () => 'what are my tasks') }
const tts = { synthesize: vi.fn(async function* () { yield new Uint8Array([9]) }) }
const runAgent = (async function* () {
  yield { type: 'text-delta', text: 'You have ' }
  yield { type: 'tool-result', name: 'search_tasks', summary: 'listed tasks (2)', undoToken: undefined }
  yield { type: 'text-delta', text: 'two tasks.' }
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
})
