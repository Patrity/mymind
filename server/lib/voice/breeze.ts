// The ONLY module that knows Breeze's wire format.
//
// Three facts here were measured against the live rig (2026-09-15) and are not
// recoverable from a response, which is why they are enforced before dispatch:
//   1. cfg_scale > 1 with no instruction => 500 "Internal Server Error" (no negative
//      prompt exists on the non-instruction templates).
//   2. ref_audio without ref_text => 500, same opaque body.
//   3. A prompt-ceiling overrun => 200 OK with a body that dies at zero bytes. The
//      status code can never carry it, because headers are sent before generation.

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
        const { done, value } = await reader.read()
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
