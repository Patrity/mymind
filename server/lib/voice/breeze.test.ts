import { describe, it, expect } from 'vitest'
import { validateBreezeRequest, type BreezeRequest } from './breeze'

const base: BreezeRequest = {
  text: 'Hello.', instruction: null, cfgScale: 1.0, seed: 11,
  temperature: 0.9, topP: 1.0, topK: 50, refAudio: null, refText: null
}

describe('validateBreezeRequest', () => {
  it('passes a plain request', () => {
    expect(validateBreezeRequest(base)).toBeNull()
  })

  // The rig answers this with 500 + an opaque "Internal Server Error" body — there is
  // nothing in the response to branch on, so it MUST be caught before dispatch.
  it('rejects cfg_scale > 1 without an instruction', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 4 }))
      .toMatch(/cfg_scale/)
  })

  it('accepts cfg_scale > 1 when an instruction is present', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 4, instruction: 'A calm man.' })).toBeNull()
  })

  it('treats a whitespace-only instruction as absent for the cfg_scale rule', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 4, instruction: '  ' }))
      .toMatch(/cfg_scale/)
  })

  it('rejects ref_audio without ref_text', () => {
    expect(validateBreezeRequest({ ...base, refAudio: { bytes: new Uint8Array([1]), filename: 'r.wav' } }))
      .toMatch(/ref_text/)
  })

  it('treats a whitespace-only ref_text as absent for the ref_audio rule', () => {
    expect(validateBreezeRequest({ ...base, refAudio: { bytes: new Uint8Array([1]), filename: 'r.wav' }, refText: '  ' }))
      .toMatch(/ref_text/)
  })

  it('rejects empty text', () => {
    expect(validateBreezeRequest({ ...base, text: '   ' })).toMatch(/text/)
  })

  it('rejects cfg_scale <= 0', () => {
    expect(validateBreezeRequest({ ...base, cfgScale: 0 })).toMatch(/cfg_scale/)
  })
})

import { vi, afterEach } from 'vitest'
import { breezeSpeak, BreezeError } from './breeze'

afterEach(() => vi.restoreAllMocks())

function pcmResponse(chunks: number[][], headers: Record<string, string> = { 'x-sample-rate': '24000' }) {
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); c.close() }
  })
  return new Response(body, { status: 200, headers })
}

async function drain(s: AsyncIterable<Uint8Array>) {
  const out: number[] = []
  for await (const c of s) out.push(...c)
  return out
}

describe('breezeSpeak', () => {
  const req = {
    text: 'Hello.', instruction: 'A calm man.', cfgScale: 4, seed: 11,
    temperature: 0.9, topP: 1.0, topK: 50, refAudio: null, refText: null
  }

  it('POSTs multipart to /v1/audio/speech with `text`, not `input`', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => pcmResponse([[1, 2, 3]]))
    vi.stubGlobal('fetch', fetchMock)
    await breezeSpeak('http://rig:8880', req)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://rig:8880/v1/audio/speech')
    const form = fetchMock.mock.calls[0]![1]!.body as FormData
    expect(form.get('text')).toBe('Hello.')
    expect(form.get('input')).toBeNull()
    expect(form.get('instruction')).toBe('A calm man.')
    expect(form.get('cfg_scale')).toBe('4')
    expect(form.get('seed')).toBe('11')
  })

  it('strips a trailing slash from the base URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => pcmResponse([[1]]))
    vi.stubGlobal('fetch', fetchMock)
    await breezeSpeak('http://rig:8880/', req)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://rig:8880/v1/audio/speech')
  })

  it('reads the sample rate from the response header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[1]], { 'x-sample-rate': '16000' })))
    const s = await breezeSpeak('http://rig:8880', req)
    expect(s.sampleRate).toBe(16000)
  })

  it('falls back to 24000 when the header is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[1]], {})))
    const s = await breezeSpeak('http://rig:8880', req)
    expect(s.sampleRate).toBe(24000)
  })

  it('streams chunks through without buffering them into one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[1, 2], [3, 4]])))
    const s = await breezeSpeak('http://rig:8880', req)
    const seen: number[][] = []
    for await (const c of s.chunks) seen.push([...c])
    expect(seen).toEqual([[1, 2], [3, 4]])
  })

  it('omits ref fields entirely when there is no reference', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => pcmResponse([[1]]))
    vi.stubGlobal('fetch', fetchMock)
    await breezeSpeak('http://rig:8880', req)
    const form = fetchMock.mock.calls[0]![1]!.body as FormData
    expect(form.get('ref_audio')).toBeNull()
  })

  it('sends ref_audio + ref_text when a reference is present', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => pcmResponse([[1]]))
    vi.stubGlobal('fetch', fetchMock)
    await breezeSpeak('http://rig:8880', {
      ...req, cfgScale: 1, instruction: null,
      refAudio: { bytes: new Uint8Array([9, 9]), filename: 'ref.wav' }, refText: 'transcript'
    })
    const form = fetchMock.mock.calls[0]![1]!.body as FormData
    expect(form.get('ref_text')).toBe('transcript')
    expect(form.get('ref_audio')).toBeInstanceOf(Blob)
  })

  it('rejects a pre-flight failure without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(breezeSpeak('http://rig:8880', { ...req, instruction: null }))
      .rejects.toMatchObject({ code: 'preflight' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps 409 to a busy error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: 'An inference request is already running.' }), { status: 409 })))
    await expect(breezeSpeak('http://rig:8880', req)).rejects.toMatchObject({ code: 'busy' })
  })

  it('maps a non-409 error status to an http error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Internal Server Error', { status: 500 })))
    await expect(breezeSpeak('http://rig:8880', req)).rejects.toMatchObject({ code: 'http' })
  })

  // THE critical case: the rig sends 200 + headers BEFORE generation, so a prompt-ceiling
  // overrun arrives as a successful response with an empty body. Yielding nothing here
  // would be silent, undetectable dropped audio.
  it('throws `truncated` when a 200 response produces zero bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([])))
    const s = await breezeSpeak('http://rig:8880', req)
    await expect(drain(s.chunks)).rejects.toMatchObject({ code: 'truncated' })
  })

  it('does not throw truncated when at least one byte arrived', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[7]])))
    const s = await breezeSpeak('http://rig:8880', req)
    await expect(drain(s.chunks)).resolves.toEqual([7])
  })
})
