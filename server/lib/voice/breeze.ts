// The ONLY module that knows Breeze's wire format.
//
// Three facts here were measured against the live rig (2026-09-15) and are not
// recoverable from a response, which is why they are enforced before dispatch:
//   1. cfg_scale > 1 with no instruction => 500 "Internal Server Error" (no negative
//      prompt exists on the non-instruction templates).
//   2. ref_audio without ref_text => 500, same opaque body.
//   3. A prompt-ceiling overrun => 200 OK, then a body that stops early. The status code
//      can never carry it, because headers are sent before generation. It arrives in two
//      shapes and both are `truncated`: a clean EOF at zero bytes, or — past roughly 3400
//      characters, measured 2026-09-15 — a dropped socket that undici raises as a bare
//      `TypeError: terminated`.
//
// Separately measured the same day: the rig caps output at 120 seconds. 900 and 1800
// characters both return exactly 5,760,000 bytes at 24kHz. That cap arrives as a FULL
// body, so no byte-count heuristic can see it — only the ceiling warning shown before
// dispatch, and ears, can.

export type BreezeErrorCode = 'preflight' | 'busy' | 'truncated' | 'http' | 'network'

export class BreezeError extends Error {
  /**
   * The error this one was classified FROM, where there was one.
   *
   * `truncated` is a judgement call, not an observation: a read that rejects mid-body is
   * *usually* the rig dropping the socket on a prompt-ceiling overrun (measured), but a
   * genuine app↔rig network fault produces the identical rejection. Classifying it as an
   * overrun and discarding the original would send whoever debugs the network fault off to
   * shorten text that was never too long. Keep the classification, keep the evidence.
   */
  constructor(public readonly code: BreezeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BreezeError'
  }
}

export interface BreezeRequest {
  text: string
  instruction: string | null
  cfgScale: number
  seed: number
  temperature: number
  topP: number
  topK: number
  refAudio: { bytes: Uint8Array; filename: string } | null
  refText: string | null
}

/** Returns a human-readable reason the request would fail at the rig, or null. */
export function validateBreezeRequest(req: BreezeRequest): string | null {
  if (!req.text?.trim()) return 'text is required'
  if (req.cfgScale <= 0) return 'cfg_scale must be greater than 0'
  if (req.cfgScale > 1 && !req.instruction?.trim()) {
    return 'cfg_scale above 1.0 requires an instruction (the clone/plain templates define no negative prompt)'
  }
  if (req.refAudio && !req.refText?.trim()) return 'ref_audio requires ref_text (the exact transcript)'
  return null
}

const DEFAULT_SAMPLE_RATE = 24000

export interface BreezeStream {
  /** From the `x-sample-rate` response header; never assume a constant. */
  sampleRate: number
  chunks: AsyncIterable<Uint8Array>
  /**
   * Resolves when the response body has been fully consumed — by the caller iterating it,
   * or by the background drain that runs when the caller walks away early.
   *
   * THE QUEUE SLOT MUST NOT BE RELEASED BEFORE THIS SETTLES. The rig is still generating
   * until its body ends; handing the slot to the next request first turns one abandoned
   * render into a 409 storm.
   */
  drained: Promise<void>
}

/**
 * Dial Breeze. Resolves once the response HEADERS are in (so the caller learns the
 * sample rate immediately); audio arrives by iterating `chunks`.
 *
 * NOT rate-limited on its own — Breeze serves one request at a time. Every caller
 * must hold a breezeQueue slot for the whole lifetime of `chunks`.
 */
export async function breezeSpeak(baseURL: string, req: BreezeRequest): Promise<BreezeStream> {
  const invalid = validateBreezeRequest(req)
  if (invalid) throw new BreezeError('preflight', invalid)

  const form = new FormData()
  form.set('text', req.text)
  if (req.instruction?.trim()) form.set('instruction', req.instruction.trim())
  form.set('cfg_scale', String(req.cfgScale))
  form.set('seed', String(req.seed))
  form.set('temperature', String(req.temperature))
  form.set('top_p', String(req.topP))
  form.set('top_k', String(req.topK))
  if (req.refAudio) {
    form.set('ref_text', req.refText ?? '')
    form.set('ref_audio', new Blob([new Uint8Array(req.refAudio.bytes)], { type: 'audio/wav' }), req.refAudio.filename)
  }

  const base = baseURL.replace(/\/$/, '')
  let res: Response
  try {
    // DELIBERATELY NO AbortSignal. The rig streams PCM from a SYNCHRONOUS Python generator,
    // and Starlette cannot interrupt one suspended mid-yield — so a client that disconnects
    // mid-stream leaves the generator abandoned, its cleanup never runs, and the rig's
    // request lock leaks. The server then 409s every later request while the GPU sits idle,
    // until a 60s watchdog force-releases it (/health reports `watchdog_releases`, which is
    // how we found we were doing this).
    //
    // Cancellation is therefore handled by DRAINING, never by aborting: see chunks() below.
    // The caller's signal still guards breezeQueue.acquire(), where aborting is safe because
    // no request exists yet.
    res = await fetch(`${base}/v1/audio/speech`, { method: 'POST', body: form })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new BreezeError('network', `Breeze unreachable at ${base}: ${(err as Error).message}`, { cause: err })
  }

  if (res.status === 409) throw new BreezeError('busy', 'Breeze is already running an inference request')
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new BreezeError('http', `Breeze returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }

  const sampleRate = Number(res.headers.get('x-sample-rate')) || DEFAULT_SAMPLE_RATE
  const body = res.body
  const reader = body.getReader()

  // Settles once the body is finished, however it finished. Everything that holds a queue
  // slot waits on this rather than on the consumer, because the RIG is still working until
  // its body ends — regardless of whether anyone is still listening.
  let markDrained!: () => void
  const drained = new Promise<void>((resolve) => { markDrained = resolve })

  /** Read the rest of the body and throw it away. This is what replaces `reader.cancel()`:
   *  cancelling tears down the HTTP response, which is the exact thing that strands the
   *  rig's generator. Reading to EOF lets the server finish and release its own lock. */
  async function drainRest(): Promise<void> {
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch {
      // The rig dropped the connection on its own — nothing left to drain, and nothing to
      // report: whoever abandoned this stream is no longer listening for errors.
    } finally {
      try { reader.releaseLock() } catch { /* already released */ }
      markDrained()
    }
  }

  async function* chunks(): AsyncIterable<Uint8Array> {
    let total = 0
    let reachedEof = false
    try {
      for (;;) {
        let done: boolean
        let value: Uint8Array | undefined
        try {
          ({ done, value } = await reader.read())
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err
          // The rig KILLED the connection part-way through the body. undici surfaces that as
          // a bare `TypeError: terminated`, which carries no diagnosis at all — it escaped
          // the route as an unhandled 500 and the user was told nothing. It is the SAME
          // condition as the zero-byte case below (an overrun the rig cannot report, because
          // it answered 200 before generation began); the only difference is whether it
          // managed a clean EOF or dropped the socket.
          //
          // `truncated` is the common case (measured), but it is a CLASSIFICATION, not an
          // observation — a real network fault between app and rig rejects identically. The
          // original rides along as `cause` so a future session debugging one is not sent off
          // to shorten text that was never too long.
          reachedEof = true   // the body is over; there is nothing left to drain
          throw new BreezeError('truncated',
            `Breeze stopped sending after ${total} bytes and dropped the connection — that is what a `
            + 'prompt-ceiling overrun looks like from here. Shorten the text, or trim the reference clip.',
            { cause: err })
        }
        if (done) { reachedEof = true; break }
        if (!value?.length) continue
        total += value.length
        yield value
      }
    } finally {
      // The consumer stopped early — a barge-in, a closed socket, a newer utterance. Do NOT
      // cancel: drain in the background so the rig finishes cleanly and frees its own lock.
      if (!reachedEof) void drainRest()
      else {
        try { reader.releaseLock() } catch { /* already released */ }
        markDrained()
      }
    }
    // 200 + zero bytes is the prompt-ceiling overrun. It cannot be detected any other
    // way: the status line was already sent before generation started.
    if (total === 0) {
      throw new BreezeError('truncated',
        'Breeze returned no audio — the prompt most likely exceeded a fast-mode bucket. Shorten the text or the reference clip.')
    }
  }

  return { sampleRate, chunks: chunks(), drained }
}

// ── Busy and warmup ──────────────────────────────────────────────────────────────────
// A 409 is the rig saying "one at a time", not a failure. Our own breezeQueue serialises
// this process, so a 409 means something OUTSIDE it holds the slot — the interim Gradio UI
// on the rig, another client, or the rig recovering from a stranded generator. All three
// clear on their own, so the right response is to wait, not to surface an error.

export const BUSY_RETRY_ATTEMPTS = 5
export const BUSY_RETRY_BASE_MS = 1500

/** 1.5s, 3s, 4.5s… — linear, because the thing being waited on is one render finishing,
 *  not a congested network where exponential backoff pays. */
export function busyBackoffMs(attempt: number): number {
  return BUSY_RETRY_BASE_MS * (attempt + 1)
}

export interface BreezeHealth {
  status: string
  busy?: boolean
  /** Increments when the rig's watchdog had to force-release a stranded generator. If this
   *  moves while we are the only client, WE abandoned a stream — see the drain in
   *  breezeSpeak. It is the one externally visible proof of that bug. */
  watchdogReleases?: number
}

/** `503 {"status":"loading"}` for ~44s after a restart while CUDA graphs are captured. */
export async function breezeHealth(baseURL: string): Promise<BreezeHealth | null> {
  const base = baseURL.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/health`)
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    return {
      status: typeof body.status === 'string' ? body.status : (res.ok ? 'ok' : 'error'),
      busy: typeof body.busy === 'boolean' ? body.busy : undefined,
      watchdogReleases: typeof body.watchdog_releases === 'number' ? body.watchdog_releases : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Wait out the rig's warmup. Returns true once it reports ready, false if it never does.
 * Called before a render rather than letting the first request fail: a 503 during warmup is
 * a "not yet", and telling the user their voice is broken because they pressed Speak 20
 * seconds after a restart would be wrong.
 */
export async function waitForBreeze(
  baseURL: string,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const pollMs = opts.pollMs ?? 2_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const health = await breezeHealth(baseURL)
    if (health?.status === 'ok') return true
    if (Date.now() >= deadline) return false
    await sleep(pollMs)
  }
}
