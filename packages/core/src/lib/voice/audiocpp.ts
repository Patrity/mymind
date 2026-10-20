// The ONLY module that knows audio.cpp's wire format for Breeze TTS.
//
// audio.cpp (0xShug0/audio.cpp, v0.9.2, `:8885`) serves the same Breeze TTS 2 weights as the
// Python server behind breeze.ts, but over a JSON request and — in `mode: "streaming"` — an
// event stream whose first audio arrives ~150 ms after the request (measured 2026-10-20, M1).
// This adapter presents exactly breeze.ts's surface (`BreezeRequest` in, `BreezeStream` out,
// the same `BreezeError` codes) so createSpeaker, the queue, the planner and both routes are
// provider agnostic. Pick between the two with `AI_TTS_PROVIDER` (see tts-provider.ts).
//
// Facts measured against the rig that shape the code below:
//   1. The sample rate is a property of the model (24 kHz) — there is no `x-sample-rate` header.
//   2. Top-level `instructions` (plural) is honoured; top-level singular `instruction` is
//      silently ignored. `options.*` values were sent as strings in every measured call.
//   3. We ask for `stream_format: "sse"`, NOT the raw audio stream (D3 B2). On raw audio the
//      server commits its 200 before taking the model lock, so busy — and every other
//      post-header failure (bad voice_ref, unknown library voice, decode error) — can only
//      look like "200, empty body". On SSE each failure is an explicit `error` event, audio
//      arrives as base64 `speech.audio.delta` events and `speech.audio.done` closes the render.
//      The decoded PCM is byte-identical to the raw stream and first audio lands at the same
//      ~150 ms (M1 G2), so the only cost is base64 on a LAN.
//   4. With `busy_timeout_ms` the server HOLDS a colliding request FIFO for that long before
//      answering busy. It is sent short (2 s, D3 B1): MyMind already serialises itself, a short
//      hold still absorbs the common overlap with an outside caller (HA / Music Assistant), and
//      createSpeaker's own linear retry covers the rest — while a 30 s hold times 5 retries made
//      a barge-in during a collision un-abortable for minutes.
//   5. The dial is abortable until first audio (D3 B1). breeze.ts never passes a signal because
//      the Python server leaks its request lock on a torn-down response; audio.cpp is a C++
//      server that ran 20 overlapping renders with no lock left behind (M1 G3). After first
//      audio the caller's signal is detached: delivery is the consumer's call (it breaks out of
//      the iterator, which cancels the body below), and a late abort must not become an error.
//   6. There is NO silent prompt-ceiling overrun: the server chunks long text itself
//      (`text_chunk_size`), and a 626-char paragraph rendered in one request where the Python
//      server dropped the socket. So nothing here is ever classified `truncated` — that code
//      is what makes calibration narrow a preset's cap, and a dropped connection on THIS path
//      is evidence about the network, not the text.
import { Buffer } from 'node:buffer'
import { BreezeError, validateBreezeRequest, type BreezeRequest, type BreezeStream, type SpeakOptions } from './breeze'

export const AUDIOCPP_MODEL = 'breeze-tts'
export const AUDIOCPP_SAMPLE_RATE = 24000
/**
 * How long the server may hold a colliding request before answering busy (fact 4). Short on
 * purpose; `AI_TTS_AUDIOCPP_BUSY_TIMEOUT_MS` overrides it (appSpeakDeps → `opts.busyTimeoutMs`).
 */
export const AUDIOCPP_BUSY_TIMEOUT_MS = 2_000
/**
 * Default single-call text ceiling for a reference-free preset on audio.cpp, in characters.
 * Deliberately conservative: a 626-char paragraph rendered cleanly (M1 G4), and the server
 * chunks text internally at 600, so 600 is the longest piece the model is known to see at
 * once. Override with `AI_TTS_AUDIOCPP_MAX_CALL_CHARS` once a higher figure is measured.
 * Breeze-Python's 950 is a measurement of where THAT server's model breaks and is not
 * transferable (different prompt buckets, different chunking).
 */
export const AUDIOCPP_DESIGN_PROMPT_BUDGET = 600

export interface AudiocppSpeakOptions extends SpeakOptions {
  /** Overrides AUDIOCPP_BUSY_TIMEOUT_MS for this call. */
  busyTimeoutMs?: number
}

/** The JSON body for `POST /v1/audio/speech`. Pure, so the mapping is testable on its own. */
export function buildAudiocppBody(req: BreezeRequest, opts: { busyTimeoutMs?: number } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: AUDIOCPP_MODEL,
    input: req.text,
    stream_format: 'sse',
    response_format: 'pcm',
    busy_timeout_ms: opts.busyTimeoutMs ?? AUDIOCPP_BUSY_TIMEOUT_MS,
    // Strings, not numbers: every call measured against v0.9.2 sent them this way and was
    // applied (seed-deterministic md5s; cfg audibly changed the output). Numbers are unverified.
    options: {
      guidance_scale: String(req.cfgScale),
      seed: String(req.seed),
      temperature: String(req.temperature),
      top_p: String(req.topP),
      top_k: String(req.topK)
    }
  }
  const instruction = req.instruction?.trim()
  if (instruction) body.instructions = instruction
  if (req.refAudio) {
    // Inline reference. The server keys its reference cache by CONTENT, so re-sending the
    // same clip costs only the base64 parse (~15 ms) after the first call — and it means a
    // locked preset's frozen render reproduces identically with no voice-dir bookkeeping.
    body.voice_ref = { type: 'base64', data: Buffer.from(req.refAudio.bytes).toString('base64') }
    body.reference_text = req.refText ?? ''
  } else if (req.voice?.trim()) {
    body.voice = req.voice.trim()
  }
  return body
}

/**
 * Dial audio.cpp. Resolves once the FIRST audio event is in hand (not merely the headers): the
 * caller's busy retry wraps the dial, so a busy `error` event has to surface before a stream is
 * handed back. The cost is one event of latency (~150 ms warm, measured) that the consumer
 * would have waited for anyway. `opts.signal` aborts the dial up to that point (fact 5) — an
 * abort rejects with a plain `AbortError`, never a BreezeError, so it is not retried.
 *
 * NOT rate-limited on its own — every caller must hold a breezeQueue slot for the lifetime
 * of `chunks`, exactly as with breezeSpeak.
 */
export async function audiocppSpeak(baseURL: string, req: BreezeRequest, opts: AudiocppSpeakOptions = {}): Promise<BreezeStream> {
  const invalid = validateBreezeRequest(req)
  if (invalid) throw new BreezeError('preflight', invalid)

  const signal = opts.signal
  if (signal?.aborted) throw abortError()

  const base = baseURL.replace(/\/$/, '')
  // An internal controller follows the caller's signal only until first audio; the fetch is
  // bound to it, and once the body is open the same handler also cancels the reader (which is
  // what settles a pending read on a server that is holding the request).
  const dial = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const onAbort = () => {
    dial.abort()
    if (reader) void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const detach = () => signal?.removeEventListener('abort', onAbort)

  let res: Response
  try {
    res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildAudiocppBody(req, { busyTimeoutMs: opts.busyTimeoutMs })),
      signal: dial.signal
    })
  } catch (err) {
    detach()
    if (signal?.aborted || isAbortError(err)) throw abortError()
    throw new BreezeError('network', `audio.cpp unreachable at ${base}: ${(err as Error).message}`, { cause: err })
  }

  const contentType = res.headers.get('content-type') ?? ''

  if (!res.ok) {
    detach()
    const detail = await res.text().catch(() => '')
    // 503 is the documented non-streaming busy; 429 is the same statement in HTTP's own words.
    if (res.status === 503 || res.status === 429 || /server_busy|is busy/i.test(detail)) {
      throw new BreezeError('busy', `audio.cpp is busy with another request (${res.status})`)
    }
    const message = `audio.cpp returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`
    // A 404/405 is a wrong base URL or route, not an invalid request — `preflight` would tell
    // the user THEIR text is bad (HTTP 400 at the studio route).
    const preflight = res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 405
    throw new BreezeError(preflight ? 'preflight' : 'http', message)
  }

  // We asked for an event stream; anything else on a 200 is an error envelope (or a server that
  // ignored `stream_format`), and must never be forwarded as PCM.
  if (!/text\/event-stream/i.test(contentType)) {
    detach()
    const text = await res.text().catch(() => '')
    const message = jsonErrorMessage(text) ?? text.slice(0, 300)
    throw new BreezeError('http', `audio.cpp answered 200 with ${contentType || 'no content-type'} instead of an event stream${message ? `: ${message}` : ''}`)
  }

  if (!res.body) {
    detach()
    throw new BreezeError('http', 'audio.cpp returned 200 with no body')
  }
  reader = res.body.getReader()
  if (signal?.aborted) onAbort() // the abort may have landed between fetch resolving and the reader existing
  const events = new SseEvents()

  // Wait for the first audio event (fact 3): busy and every other failure arrive here as an
  // `error` event; `done` with no audio is a legitimate empty render.
  let first: Uint8Array | null
  try {
    first = await readFirstAudio(reader, events, signal)
  } catch (err) {
    releaseQuietly(reader)
    throw err
  } finally {
    detach()
  }

  let markDrained!: () => void
  const drained = new Promise<void>((resolve) => {
    markDrained = resolve
  })
  const body = reader

  async function* chunks(): AsyncIterable<Uint8Array> {
    let total = 0
    let finished = first === null
    try {
      if (first === null) return
      total += first.length
      yield first
      for (;;) {
        let done: boolean
        let value: Uint8Array | undefined
        try {
          ({ done, value } = await body.read())
        } catch (err) {
          finished = true
          // A dropped socket mid-body. Unlike the Python server this is never a prompt-ceiling
          // symptom (fact 6), so it is reported as what it most likely is — a path fault — and
          // the original error rides along as `cause`.
          throw new BreezeError('network',
            `audio.cpp stopped sending after ${total} bytes and dropped the connection.`, { cause: err })
        }
        if (done) {
          finished = true
          break
        }
        if (!value?.length) continue
        let ended = false
        for (const ev of events.push(value)) {
          if (ev.kind === 'audio') {
            total += ev.bytes.length
            yield ev.bytes
          } else if (ev.kind === 'done') {
            ended = true
            break
          } else {
            finished = true
            throw new BreezeError(/busy/i.test(ev.message) ? 'busy' : 'http',
              `audio.cpp reported an error after ${total} bytes: ${ev.message}`)
          }
        }
        if (ended) {
          // The render is complete; whatever trails `done` (the `[DONE]` sentinel) is not audio.
          // Cancelling here lets undici release the connection without reading it out.
          finished = true
          await body.cancel().catch(() => {})
          break
        }
      }
    } finally {
      if (!finished) {
        // The consumer walked away (barge-in, closed socket, a newer utterance). CANCEL the
        // response rather than drain it: audio.cpp is a C++ server that handles a torn-down
        // stream cleanly (20 back-to-back renders with deliberate overlaps left no lock
        // behind, M1 G3), so there is no generator to strand and no reason to let the rig
        // finish synthesising audio nobody will hear. If the server does keep generating
        // for a moment after the cancel, the next request simply waits its turn behind the
        // FIFO `busy_timeout_ms` instead of failing — which is why `drained` can settle now.
        try {
          await body.cancel()
        } catch {
          // the body may already be gone
        }
      }
      releaseQuietly(body)
      markDrained()
    }
  }

  return { sampleRate: AUDIOCPP_SAMPLE_RATE, chunks: chunks(), drained }
}

/**
 * Read until the first audio event. Returns its bytes; `null` when the render completed with no
 * audio at all. Throws `busy`/`http` on an `error` event, `http` when the stream ends without
 * ever reaching audio or done, and `AbortError` when `signal` fires meanwhile.
 */
async function readFirstAudio(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  events: SseEvents,
  signal: AbortSignal | undefined
): Promise<Uint8Array | null> {
  for (;;) {
    let done: boolean
    let value: Uint8Array | undefined
    try {
      ({ done, value } = await reader.read())
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw abortError()
      throw new BreezeError('network', `audio.cpp dropped the connection before sending audio: ${(err as Error).message}`, { cause: err })
    }
    if (signal?.aborted) throw abortError()
    if (done) {
      throw new BreezeError('http', events.sawAny
        ? 'audio.cpp ended the event stream without audio or a done event.'
        : 'audio.cpp answered 200 and closed the event stream without sending any event.')
    }
    if (!value?.length) continue
    for (const ev of events.push(value)) {
      if (ev.kind === 'audio') return ev.bytes
      if (ev.kind === 'done') return null
      if (/busy/i.test(ev.message)) throw new BreezeError('busy', `audio.cpp is busy with another request: ${ev.message}`)
      throw new BreezeError('http', `audio.cpp reported an error: ${ev.message}`)
    }
  }
}

type SseEvent =
  | { kind: 'audio', bytes: Uint8Array }
  | { kind: 'done' }
  | { kind: 'error', message: string }

/**
 * Incremental parser for audio.cpp's event stream. Frames are `data: <json>` lines separated by a
 * blank line; TCP reads do not respect frame boundaries, so partial frames are carried over.
 * Unknown event types (e.g. `speech.text.delta`) are skipped; `data: [DONE]` is treated as done.
 */
class SseEvents {
  private decoder = new TextDecoder()
  private buffer = ''
  /** Whether any complete event has been parsed — tells "closed before anything" from "closed early". */
  sawAny = false

  push(bytes: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(bytes, { stream: true })
    const out: SseEvent[] = []
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buffer)
      if (!m) break
      const frame = this.buffer.slice(0, m.index)
      this.buffer = this.buffer.slice(m.index + m[0].length)
      const ev = parseFrame(frame)
      if (ev) {
        this.sawAny = true
        out.push(ev)
      }
    }
    return out
  }
}

function parseFrame(frame: string): SseEvent | null {
  const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
  if (!data) return null
  if (data === '[DONE]') return { kind: 'done' }
  let ev: { type?: unknown, audio?: unknown, error?: { message?: unknown } }
  try {
    ev = JSON.parse(data) as typeof ev
  } catch {
    return null
  }
  if (ev.type === 'speech.audio.delta') {
    return typeof ev.audio === 'string' && ev.audio ? { kind: 'audio', bytes: new Uint8Array(Buffer.from(ev.audio, 'base64')) } : null
  }
  if (ev.type === 'speech.audio.done') return { kind: 'done' }
  if (ev.type === 'error') return { kind: 'error', message: typeof ev.error?.message === 'string' ? ev.error.message : 'unknown error' }
  return null
}

/** `error.message` out of a JSON error envelope, if `text` is one. */
function jsonErrorMessage(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } }
    return typeof parsed.error?.message === 'string' ? parsed.error.message : null
  } catch {
    return null
  }
}

function abortError(): DOMException {
  return new DOMException('audio.cpp dial aborted by the caller', 'AbortError')
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** `releaseLock()` throws once the reader is already released; there is nothing to do then. */
function releaseQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock()
  } catch {
    // already released
  }
}
