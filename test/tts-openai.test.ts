// test/tts-openai.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { openAiTts } from '../server/lib/voice/providers/tts-openai'

afterEach(() => vi.restoreAllMocks())

describe('openAiTts', () => {
  it('POSTs to /audio/speech with voice + yields the streamed response bytes', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close() } })
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const tts = openAiTts({ baseURL: 'http://rig:8884/v1', model: 'chatterbox', apiKey: '' })
    const chunks: number[] = []
    for await (const c of tts.synthesize('hi', { voice: 'happy-us.wav' })) chunks.push(...c)
    expect(chunks).toEqual([1, 2, 3])
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://rig:8884/v1/audio/speech')
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent).toMatchObject({ model: 'chatterbox', voice: 'happy-us.wav', input: 'hi', response_format: 'wav' })
  })
})
