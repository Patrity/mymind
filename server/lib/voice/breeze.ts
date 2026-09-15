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
