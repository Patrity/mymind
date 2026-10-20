// test/stt-whisper.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { whisperStt } from '@mymind/core/lib/voice/providers/stt-whisper'

afterEach(() => vi.restoreAllMocks())

describe('whisperStt', () => {
  it('POSTs multipart audio to /audio/transcriptions and returns trimmed text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: ' hello there ' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const stt = whisperStt({ baseURL: 'http://rig:8881/v1', model: 'deepdml/faster-whisper-large-v3-turbo-ct2', apiKey: '', toWav: async a => ({ audio: a, converted: false }) })
    const text = await stt.transcribe(new Uint8Array([1, 2, 3]), { language: 'en' })
    expect(text).toBe('hello there')
    expect(String((fetchMock.mock.calls[0] as any[])[0])).toBe('http://rig:8881/v1/audio/transcriptions')
    expect((fetchMock.mock.calls[0] as any[])[1].method).toBe('POST')
  })
})

describe('whisperStt — upload labelling', () => {
  async function formFor(opts?: { mime?: string; filename?: string }) {
    const fetchMock = vi.fn(async (_u: unknown, _init: RequestInit) => new Response(JSON.stringify({ text: 'x' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await whisperStt({ baseURL: 'http://rig/v1', model: 'm', toWav: async a => ({ audio: a, converted: false }) }).transcribe(new Uint8Array([1]), opts)
    return ((fetchMock.mock.calls[0] as any[])[1].body as FormData).get('file') as File
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

describe('whisperStt — WAV conversion', () => {
  function capture() {
    const fetchMock = vi.fn(async (_u: unknown, _init: RequestInit) => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    return () => ((fetchMock.mock.calls[0] as any[])[1].body as FormData).get('file') as File
  }

  it('uploads converted audio relabelled as WAV when the input is not WAV', async () => {
    const file = capture()
    const toWav = vi.fn(async () => ({ audio: new Uint8Array([0x52, 0x49, 0x46, 0x46]), converted: true }))
    await whisperStt({ baseURL: 'http://rig/v1', model: 'm', toWav }).transcribe(new Uint8Array([0x49, 0x44, 0x33]), { mime: 'audio/mpeg', filename: 'memo.mp3' })
    expect(toWav).toHaveBeenCalledOnce()
    expect(file().type).toBe('audio/wav')
    expect(file().name).toBe('memo.wav')
    expect(new Uint8Array(await file().arrayBuffer())).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46]))
  })

  it('keeps the caller labels when conversion fails soft', async () => {
    const file = capture()
    const toWav = vi.fn(async (a: Uint8Array) => ({ audio: a, converted: false }))
    await whisperStt({ baseURL: 'http://rig/v1', model: 'm', toWav }).transcribe(new Uint8Array([1]), { mime: 'audio/x-caf', filename: 'a.caf' })
    expect(file().type).toBe('audio/x-caf')
    expect(file().name).toBe('a.caf')
  })
})
