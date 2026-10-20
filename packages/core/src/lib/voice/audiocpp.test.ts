import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  audiocppSpeak, buildAudiocppBody,
  AUDIOCPP_MODEL, AUDIOCPP_SAMPLE_RATE, AUDIOCPP_BUSY_TIMEOUT_MS
} from './audiocpp'
import type { BreezeRequest } from './breeze'

afterEach(() => vi.restoreAllMocks())

const design: BreezeRequest = {
  text: 'Hello.', instruction: 'A calm man.', cfgScale: 4, seed: 11,
  temperature: 0.9, topP: 1.0, topK: 50, refAudio: null, refText: null
}
const refBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 3])
const clone: BreezeRequest = {
  ...design, instruction: null, cfgScale: 1,
  refAudio: { bytes: refBytes, filename: 'reference.wav' }, refText: 'the transcript'
}

// audio.cpp's SSE contract (app/server/api.md; M1 G2): `data: {"type":"speech.audio.delta","audio":"<b64 PCM>"}`
// per chunk, then `speech.audio.done {timing}`, then `data: [DONE]`; a failure is one `error` event.
const enc = new TextEncoder()
const sseEvent = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const delta = (bytes: number[]) => sseEvent({ type: 'speech.audio.delta', audio: Buffer.from(bytes).toString('base64') })
const DONE = sseEvent({ type: 'speech.audio.done', timing: { ttft_ms: 73.2 } }) + 'data: [DONE]\n\n'
const BUSY_EVENT = sseEvent({ type: 'error', error: { message: "model 'breeze-tts' is busy (busy_timeout_ms=2000)" } })

/** One network chunk per frame string (so a test can split an event across reads deliberately). */
function sseResponse(frames: string[], init: ResponseInit = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init })
}
/** The common happy path: each pcm chunk is its own delta event, then done. */
const pcmResponse = (chunks: number[][], init: ResponseInit = {}) => sseResponse([...chunks.map(delta), DONE], init)

async function drain(s: AsyncIterable<Uint8Array>) {
  const out: number[] = []
  for await (const c of s) out.push(...c)
  return out
}

function sentBody(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]![1] as RequestInit
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

// ── Request body ───────────────────────────────────────────────────────────────────────

describe('buildAudiocppBody', () => {
  // D3 B2: the SSE stream, not the raw audio stream. On raw audio a busy collision is a 200 with an
  // empty body — indistinguishable from any other post-header failure. On SSE busy is an explicit
  // `error` event and the PCM is byte-identical (M1 G2), so there is nothing to guess at.
  it('asks for the SSE event stream of the breeze-tts model, PCM-encoded', () => {
    const body = buildAudiocppBody(design)
    expect(body).toMatchObject({
      model: AUDIOCPP_MODEL,
      input: 'Hello.',
      stream_format: 'sse',
      response_format: 'pcm'
    })
    expect(AUDIOCPP_MODEL).toBe('breeze-tts')
  })

  // D3 B1: the server HOLDS a colliding request for busy_timeout_ms before answering busy, and the
  // caller retries 5x on top. 30 s made a barge-in during a collision un-abortable for minutes; 2 s
  // keeps the server-side FIFO for short overlaps while createSpeaker's own backoff does the rest.
  it('sends a SHORT busy_timeout_ms by default, overridable per call', () => {
    expect(buildAudiocppBody(design).busy_timeout_ms).toBe(AUDIOCPP_BUSY_TIMEOUT_MS)
    expect(AUDIOCPP_BUSY_TIMEOUT_MS).toBe(2_000)
    expect(buildAudiocppBody(design, { busyTimeoutMs: 5_000 }).busy_timeout_ms).toBe(5_000)
  })

  // Measured 2026-10-20: top-level `instructions` (plural) is applied; top-level singular
  // `instruction` is silently ignored by this server, so the plural is the only safe key.
  it('maps a design preset onto top-level `instructions` plus the sampling options', () => {
    const body = buildAudiocppBody(design)
    expect(body.instructions).toBe('A calm man.')
    expect(body.options).toEqual({
      guidance_scale: '4', seed: '11', temperature: '0.9', top_p: '1', top_k: '50'
    })
    expect(body).not.toHaveProperty('voice')
    expect(body).not.toHaveProperty('voice_ref')
    expect(body).not.toHaveProperty('reference_text')
  })

  it('omits `instructions` when the preset carries none', () => {
    const body = buildAudiocppBody({ ...design, instruction: null, cfgScale: 1 })
    expect(body).not.toHaveProperty('instructions')
  })

  it('treats a whitespace-only instruction as absent', () => {
    const body = buildAudiocppBody({ ...design, instruction: '   ', cfgScale: 1 })
    expect(body).not.toHaveProperty('instructions')
  })

  // The reference rides inline as base64 + its transcript. audio.cpp keys its reference
  // cache by content, so sending the same clip every call costs only the base64 parse
  // (~15 ms measured) after the first.
  it('maps a clone preset onto an inline base64 voice_ref + reference_text', () => {
    const body = buildAudiocppBody(clone)
    expect(body.voice_ref).toEqual({ type: 'base64', data: Buffer.from(refBytes).toString('base64') })
    expect(body.reference_text).toBe('the transcript')
    expect(body).not.toHaveProperty('voice')
    expect(body).not.toHaveProperty('instructions')
  })

  it('keeps the instruction on a direction preset (clip + instruction)', () => {
    const body = buildAudiocppBody({ ...clone, instruction: 'Warmly.', cfgScale: 2 })
    expect(body.instructions).toBe('Warmly.')
    expect(body.voice_ref).toBeDefined()
  })

  it('maps a library voice onto `voice:<name>` with no inline reference', () => {
    const body = buildAudiocppBody({ ...design, instruction: null, cfgScale: 1, voice: 'happy-us' })
    expect(body.voice).toBe('happy-us')
    expect(body).not.toHaveProperty('voice_ref')
    expect(body).not.toHaveProperty('reference_text')
  })

  // An inline clip is the preset's own frozen render — it must win over a library name if
  // both were ever set, because it is what the preset was calibrated against.
  it('prefers an inline reference over a library voice name', () => {
    const body = buildAudiocppBody({ ...clone, voice: 'happy-us' })
    expect(body.voice_ref).toBeDefined()
    expect(body).not.toHaveProperty('voice')
  })
})

// ── Streaming ──────────────────────────────────────────────────────────────────────────

describe('audiocppSpeak', () => {
  it('POSTs JSON to /v1/audio/speech', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => pcmResponse([[1, 2, 3]]))
    vi.stubGlobal('fetch', fetchMock)
    await audiocppSpeak('http://rig:8885/', design)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://rig:8885/v1/audio/speech')
    const init = fetchMock.mock.calls[0]![1]!
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(sentBody(fetchMock).input).toBe('Hello.')
  })

  // There is no x-sample-rate header on this server; the rate is a property of the model.
  it('reports the constant 24 kHz sample rate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[1]])))
    const s = await audiocppSpeak('http://rig:8885', design)
    expect(s.sampleRate).toBe(AUDIOCPP_SAMPLE_RATE)
    expect(AUDIOCPP_SAMPLE_RATE).toBe(24000)
  })

  it('streams the PCM chunks through in order, decoded from the delta events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[1, 2], [3, 4], [5]])))
    const s = await audiocppSpeak('http://rig:8885', design)
    const seen: number[][] = []
    for await (const c of s.chunks) seen.push([...c])
    expect(seen).toEqual([[1, 2], [3, 4], [5]])
  })

  // SSE frames do not respect TCP chunk boundaries: one read may carry half an event, or two.
  it('reassembles an event split across network reads and splits two events in one read', async () => {
    const two = delta([7, 8]) + delta([9])
    const d1 = delta([1, 2, 3])
    const half = Math.floor(d1.length / 2)
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([d1.slice(0, half), d1.slice(half), two, DONE])))
    const s = await audiocppSpeak('http://rig:8885', design)
    const seen: number[][] = []
    for await (const c of s.chunks) seen.push([...c])
    expect(seen).toEqual([[1, 2, 3], [7, 8], [9]])
  })

  it('ends cleanly at `speech.audio.done` / [DONE] and ignores text events it does not know', async () => {
    const unknown = sseEvent({ type: 'speech.text.delta', text: 'Hello.' })
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([unknown, delta([1]), DONE, delta([99])])))
    const s = await audiocppSpeak('http://rig:8885', design)
    const seen: number[][] = []
    for await (const c of s.chunks) seen.push([...c])
    expect(seen).toEqual([[1]]) // nothing after done is audio
  })

  // Punctuation-only text passes validateBreezeRequest and synthesises to nothing: that is a
  // legitimate empty render, not an error and not busy.
  it('resolves an empty stream when the server reports done with no audio', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([DONE])))
    const s = await audiocppSpeak('http://rig:8885', design)
    expect(await drain(s.chunks)).toEqual([])
    await expect(s.drained).resolves.toBeUndefined()
  })

  // The first chunk is peeked (to tell an empty busy body from audio) but the rest must not
  // be buffered: the second chunk is observable before the third exists.
  it('yields early chunks before later ones have arrived (no buffer-then-replay)', async () => {
    let openGate = () => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    let thirdEnqueued = false
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode(delta([1])))
        controller.enqueue(enc.encode(delta([2])))
        await gate
        controller.enqueue(enc.encode(delta([3])))
        thirdEnqueued = true
        controller.enqueue(enc.encode(DONE))
        controller.close()
      }
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const s = await audiocppSpeak('http://rig:8885', design)
    const it = s.chunks[Symbol.asyncIterator]()
    expect([...(await it.next()).value!]).toEqual([1])
    expect([...(await it.next()).value!]).toEqual([2])
    expect(thirdEnqueued).toBe(false)
    openGate()
    expect([...(await it.next()).value!]).toEqual([3])
    expect((await it.next()).done).toBe(true)
  }, 5000)

  it('rejects a pre-flight failure without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(audiocppSpeak('http://rig:8885', { ...design, text: '  ' }))
      .rejects.toMatchObject({ code: 'preflight' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── The three busy shapes (measured 2026-10-20, M1 §5.1) ──
  // All three must become `busy` BEFORE the stream is handed back, because createSpeaker's
  // retry wraps the dial, not the body.

  it('maps the non-streaming 503 server_busy to `busy`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { type: 'server_busy', message: 'model \'breeze-tts\' is busy' } }),
      { status: 503, headers: { 'content-type': 'application/json' } })))
    await expect(audiocppSpeak('http://rig:8885', design)).rejects.toMatchObject({ code: 'busy' })
  })

  // D3 B2: on the SSE stream the server has an event channel, so a 200 that closes without a
  // single event is NOT the busy shape — it is a server that failed after committing headers,
  // and calling it "busy" sent debugging the wrong way for 22 s of retries.
  it('maps a 200 that ends without any event to `http`, never to `busy`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([])))
    await expect(audiocppSpeak('http://rig:8885', design))
      .rejects.toMatchObject({ code: 'http', message: expect.stringMatching(/without/i) })
  })

  it('maps an SSE `error` event with the short busy timeout to `busy`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([BUSY_EVENT])))
    await expect(audiocppSpeak('http://rig:8885', design)).rejects.toMatchObject({ code: 'busy' })
  })

  // D3 B5: a 200 whose body is a JSON envelope must not be forwarded as PCM.
  it('maps a 200 that is not an event stream (JSON error envelope) to `http` with its message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"voice not found"}}', {
      status: 200, headers: { 'content-type': 'application/json' }
    })))
    await expect(audiocppSpeak('http://rig:8885', design))
      .rejects.toMatchObject({ code: 'http', message: expect.stringMatching(/voice not found/) })
  })

  it('maps an SSE `error` event to `busy` when the server reports the model busy', async () => {
    const sse = 'data: {"type":"error","error":{"message":"model \'breeze-tts\' is busy (busy_timeout_ms=100)"}}\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, {
      status: 200, headers: { 'content-type': 'text/event-stream' }
    })))
    await expect(audiocppSpeak('http://rig:8885', design)).rejects.toMatchObject({ code: 'busy' })
  })

  it('maps an SSE `error` event that is NOT about busyness to `http`', async () => {
    const sse = 'data: {"type":"error","error":{"message":"unknown voice"}}\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, {
      status: 200, headers: { 'content-type': 'text/event-stream' }
    })))
    await expect(audiocppSpeak('http://rig:8885', design)).rejects.toMatchObject({ code: 'http' })
  })

  it('maps a 400 to `preflight` and a 5xx to `http`, keeping the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"bad voice_ref"}}', { status: 400 })))
    await expect(audiocppSpeak('http://rig:8885', design)).rejects.toMatchObject({ code: 'preflight' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await expect(audiocppSpeak('http://rig:8885', design))
      .rejects.toMatchObject({ code: 'http', message: expect.stringMatching(/500.*boom/) })
  })

  // D3 B4: a 404 is a wrong base URL, not an invalid request (preflight → HTTP 400 to the user);
  // a 429 is the server saying "later", which is what `busy` already means to createSpeaker.
  it('maps 404/405 to `http` and 429 to `busy`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    await expect(audiocppSpeak('http://rig:8885', design)).rejects.toMatchObject({ code: 'http' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 405 })))
    await expect(audiocppSpeak('http://rig:8885', design)).rejects.toMatchObject({ code: 'http' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })))
    await expect(audiocppSpeak('http://rig:8885', design)).rejects.toMatchObject({ code: 'busy' })
  })

  it('maps an unreachable server to `network` with the cause attached', async () => {
    const underlying = new TypeError('fetch failed')
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw underlying
    }))
    await expect(audiocppSpeak('http://rig:8885', design))
      .rejects.toMatchObject({ code: 'network', cause: underlying })
  })

  // A timeout is a fault of the path, never of the text: audio.cpp has no silent
  // prompt-ceiling overrun (it chunks long inputs itself), so nothing here may be
  // classified `truncated` — that code is what makes calibration narrow a preset's cap.
  it('reports a body that dies mid-stream as `network`, never as `truncated`', async () => {
    const underlying = new TypeError('terminated')
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(delta([1, 2]))) },
      pull(c) { c.error(underlying) }
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const s = await audiocppSpeak('http://rig:8885', design)
    const got: number[] = []
    const consume = async () => {
      for await (const c of s.chunks) got.push(...c)
    }
    await expect(consume()).rejects.toMatchObject({ code: 'network', cause: underlying })
    expect(got).toEqual([1, 2])
    await expect(s.drained).resolves.toBeUndefined()
  })

  it('resolves `drained` once a body is fully consumed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[1], [2]])))
    const s = await audiocppSpeak('http://rig:8885', design)
    await drain(s.chunks)
    await expect(s.drained).resolves.toBeUndefined()
  })

  // The Breeze adapter drains an abandoned body to EOF because the Python server leaks its
  // request lock if a response is torn down mid-generator. audio.cpp is a C++ server with
  // no such hazard, so walking away CANCELS the response: the rig stops generating audio
  // nobody will hear, and the queue slot is free immediately.
  it('cancels the response and settles `drained` at once when the consumer walks away', async () => {
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++
        c.enqueue(enc.encode(delta([pulls])))
      },
      cancel() {
        cancelled = true
      }
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const s = await audiocppSpeak('http://rig:8885', design)
    for await (const _ of s.chunks) break // a barge-in after the first chunk
    await s.drained
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThanOrEqual(3) // the peek, the yield, at most one read-ahead
  })

  // ── D3 B1: the dial is abortable until the first audio event ──
  // audio.cpp HOLDS a colliding request for busy_timeout_ms before answering. Breeze's "never pass
  // the signal" rule protected a Python generator lock that this C++ server does not have, so the
  // caller's signal now cancels the fetch — but only before first audio; after that the consumer's
  // own break drives the cancel path above, and a late abort must not turn the stream into an error.

  /** A fetch mock that honours `init.signal` the way undici does: never resolves, rejects on abort. */
  function hangingFetch() {
    return vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
    }))
  }

  it('passes the caller\'s signal to fetch and rejects with AbortError when it fires before headers', async () => {
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const ac = new AbortController()
    const p = audiocppSpeak('http://rig:8885', design, { signal: ac.signal })
    setTimeout(() => ac.abort(), 5)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBeDefined()
  })

  it('rejects with AbortError when the abort lands while waiting for the first event (headers in, body stalled)', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise(() => {}) }, // the server is holding the request
      cancel() { cancelled = true }
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const ac = new AbortController()
    const p = audiocppSpeak('http://rig:8885', design, { signal: ac.signal })
    setTimeout(() => ac.abort(), 5)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
  })

  it('an abort AFTER the first audio event does not error the stream — delivery stays the consumer\'s call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pcmResponse([[1], [2], [3]])))
    const ac = new AbortController()
    const s = await audiocppSpeak('http://rig:8885', design, { signal: ac.signal })
    const it = s.chunks[Symbol.asyncIterator]()
    expect([...(await it.next()).value!]).toEqual([1])
    ac.abort()
    expect([...(await it.next()).value!]).toEqual([2])
    expect([...(await it.next()).value!]).toEqual([3])
    expect((await it.next()).done).toBe(true)
  })

  it('an already-aborted signal rejects without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(audiocppSpeak('http://rig:8885', design, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
