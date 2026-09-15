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

  // Distinguishes true streaming from buffer-then-replay: a `[[1,2],[3,4]]` result
  // alone (the test above) can't tell the two apart — an implementation that fully
  // drains the reader into an array and then `yield*`s it would produce the same
  // final result while destroying time-to-first-audio, which is the entire point
  // of this migration. This test proves the first chunk is observable BEFORE the
  // second chunk has even been enqueued.
  it('yields the first chunk before the second has arrived (no buffer-then-replay)', async () => {
    let openGate = () => {}
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    let secondEnqueued = false

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        await gate
        controller.enqueue(new Uint8Array([3, 4]))
        secondEnqueued = true
        controller.close()
      }
    })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(body, { status: 200, headers: { 'x-sample-rate': '24000' } })))

    const s = await breezeSpeak('http://rig:8880', req)
    const iterator = s.chunks[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect([...first.value!]).toEqual([1, 2])
    // If we got here, the generator yielded without waiting for the gate — i.e.
    // without waiting for the second chunk to exist at all.
    expect(secondEnqueued).toBe(false)

    openGate()
    const second = await iterator.next()
    expect(second.done).toBe(false)
    expect([...second.value!]).toEqual([3, 4])

    const final = await iterator.next()
    expect(final.done).toBe(true)
  }, 5000)

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

// The rig does not always manage a clean EOF. Past roughly 3400 characters it drops the
// socket part-way through the body, which undici raises as a bare `TypeError: terminated`.
// Measured against the live rig 2026-09-15: 3600 chars terminated after ~70ms, and the
// throw escaped the route unmapped — Nitro logged "[unhandled]" and answered 500 "Server
// Error". Same condition as the zero-byte case, so it must carry the same diagnosis.
describe('breezeSpeak — a body that dies mid-stream', () => {
  const req = {
    text: 'Hello.', instruction: 'A calm man.', cfgScale: 4, seed: 11,
    temperature: 0.9, topP: 1.0, topK: 50, refAudio: null, refText: null
  }

  function dyingResponse(before: number[][], err: Error) {
    const body = new ReadableStream<Uint8Array>({
      start(c) { for (const ch of before) c.enqueue(new Uint8Array(ch)) },
      pull(c) { c.error(err) }
    })
    return new Response(body, { status: 200, headers: { 'x-sample-rate': '24000' } })
  }

  it('reports a dropped connection as `truncated`, not as an opaque failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => dyingResponse([[1, 2]], new TypeError('terminated'))))
    const s = await breezeSpeak('http://rig:8880', req)
    await expect(drain(s.chunks)).rejects.toMatchObject({ code: 'truncated' })
  })

  it('names the overrun in the message rather than leaking undici wording', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => dyingResponse([[1, 2]], new TypeError('terminated'))))
    const s = await breezeSpeak('http://rig:8880', req)
    await expect(drain(s.chunks)).rejects.toThrow(/prompt-ceiling overrun/)
  })

  it('still yields everything that DID arrive before the drop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => dyingResponse([[7, 8], [9]], new TypeError('terminated'))))
    const s = await breezeSpeak('http://rig:8880', req)
    const got: number[] = []
    await expect((async () => { for await (const c of s.chunks) got.push(...c) })())
      .rejects.toMatchObject({ code: 'truncated' })
    expect(got).toEqual([7, 8, 9])
  })

  // A caller walking away must never be dressed as a rig failure: the registry and the
  // route both branch on AbortError to keep a barge-in out of the error counts.
  it('lets an AbortError through untouched instead of calling it a truncation', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(async () => dyingResponse([[1]], abort)))
    const s = await breezeSpeak('http://rig:8880', req)
    await expect(drain(s.chunks)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not call an aborted read a truncation even when the error is not named AbortError', async () => {
    const ac = new AbortController()
    ac.abort()
    vi.stubGlobal('fetch', vi.fn(async () => dyingResponse([[1]], new TypeError('terminated'))))
    const s = await breezeSpeak('http://rig:8880', req, ac.signal)
    await expect(drain(s.chunks)).rejects.not.toMatchObject({ code: 'truncated' })
  })
})
