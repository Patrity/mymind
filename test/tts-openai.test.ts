// test/tts-openai.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { openAiTts } from '../server/lib/voice/providers/tts-openai'

afterEach(() => vi.restoreAllMocks())

describe('openAiTts', () => {
  it('POSTs to /audio/speech with voice + yields one complete WAV (reassembled body)', async () => {
    // Server streams the WAV body in fragments; the provider must buffer it into a
    // single self-contained WAV so the client can decodeAudioData each frame whole.
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close() } })
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const tts = openAiTts({ baseURL: 'http://rig:8884/v1', model: 'chatterbox', apiKey: '' })
    const frames: Uint8Array[] = []
    for await (const c of tts.synthesize('hi', { voice: 'happy-us.wav' })) frames.push(c)
    expect(frames).toHaveLength(1)
    expect([...frames[0]!]).toEqual([1, 2, 3])
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://rig:8884/v1/audio/speech')
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent).toMatchObject({ model: 'chatterbox', voice: 'happy-us.wav', input: 'hi', response_format: 'wav' })
  })
})
