// test/stt-whisper.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { whisperStt } from '@mymind/core/lib/voice/providers/stt-whisper'

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

describe('whisperStt — upload labelling', () => {
  async function formFor(opts?: { mime?: string; filename?: string }) {
    const fetchMock = vi.fn(async (_u: unknown, _init: RequestInit) => new Response(JSON.stringify({ text: 'x' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await whisperStt({ baseURL: 'http://rig/v1', model: 'm' }).transcribe(new Uint8Array([1]), opts)
    return (fetchMock.mock.calls[0]![1].body as FormData).get('file') as File
  }

  it('labels the upload with the caller MIME type and filename (e.g. an iMessage .caf voice memo)', async () => {
    const file = await formFor({ mime: 'audio/x-caf', filename: 'a.caf' })
    expect(file.type).toBe('audio/x-caf')
    expect(file.name).toBe('a.caf')
  })

  it('defaults to audio/wav utterance.wav', async () => {
    const file = await formFor()
    expect(file.type).toBe('audio/wav')
    expect(file.name).toBe('utterance.wav')
  })
})
