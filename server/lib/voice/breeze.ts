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
  constructor(public readonly code: BreezeErrorCode, message: string) {
    super(message)
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
}

/**
 * Dial Breeze. Resolves once the response HEADERS are in (so the caller learns the
 * sample rate immediately); audio arrives by iterating `chunks`.
 *
 * NOT rate-limited on its own — Breeze serves one request at a time. Every caller
 * must hold a breezeQueue slot for the whole lifetime of `chunks`.
 */
export async function breezeSpeak(baseURL: string, req: BreezeRequest, signal?: AbortSignal): Promise<BreezeStream> {
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
    res = await fetch(`${base}/v1/audio/speech`, { method: 'POST', body: form, signal })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new BreezeError('network', `Breeze unreachable at ${base}: ${(err as Error).message}`)
  }

  if (res.status === 409) throw new BreezeError('busy', 'Breeze is already running an inference request')
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new BreezeError('http', `Breeze returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }

  const sampleRate = Number(res.headers.get('x-sample-rate')) || DEFAULT_SAMPLE_RATE
  const body = res.body

  async function* chunks(): AsyncIterable<Uint8Array> {
    let total = 0
    const reader = body.getReader()
    try {
      for (;;) {
        let done: boolean
        let value: Uint8Array | undefined
        try {
          ({ done, value } = await reader.read())
        } catch (err) {
          // A caller walking away (barge-in, a closed socket, a newer utterance) is NOT a
          // rig failure — it must stay an AbortError so the route and the registry can
          // keep telling the two apart.
          if ((err as Error).name === 'AbortError' || signal?.aborted) throw err
          // Otherwise the rig KILLED the connection part-way through the body. undici
          // surfaces that as a bare `TypeError: terminated`, which carries no diagnosis at
          // all — it escaped the route as an unhandled 500 "Server Error" and the user was
          // told nothing. It is the SAME condition as the zero-byte case below (an overrun
          // the rig cannot report, because it answered 200 before generation began); the
          // only difference is whether it managed a clean EOF or dropped the socket.
          throw new BreezeError('truncated',
            `Breeze stopped sending after ${total} bytes and dropped the connection — that is what a `
            + 'prompt-ceiling overrun looks like from here. Shorten the text, or trim the reference clip.')
        }
        if (done) break
        if (!value?.length) continue
        total += value.length
        yield value
      }
    } finally {
      reader.releaseLock()
    }
    // 200 + zero bytes is the prompt-ceiling overrun. It cannot be detected any other
    // way: the status line was already sent before generation started.
    if (total === 0) {
      throw new BreezeError('truncated',
        'Breeze returned no audio — the prompt most likely exceeded a fast-mode bucket. Shorten the text or the reference clip.')
    }
  }

  return { sampleRate, chunks: chunks() }
}
