// test/stt-whisper.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { whisperStt } from '../server/lib/voice/providers/stt-whisper'

afterEach(() => vi.restoreAllMocks())

describe('whisperStt', () => {
  it('POSTs multipart audio to /audio/transcriptions and returns trimmed text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: ' hello there ' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const stt = whisperStt({ baseURL: 'http://rig:8881/v1', model: 'deepdml/faster-whisper-large-v3-turbo-ct2', apiKey: '' })
    const text = await stt.transcribe(new Uint8Array([1, 2, 3]), { language: 'en' })
    expect(text).toBe('hello there')
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://rig:8881/v1/audio/transcriptions')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
  })
})
