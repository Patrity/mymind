// app/lib/voice/generation.ts
// Guards async work against the thing it was started FOR being swapped out underneath it.
//
// The design pane is one form bound to whichever preset is selected. Every slow operation
// it starts — a reference upload, a mic recording's decode, a four-take audition — was
// started for one preset and resolves whenever it resolves. Without a guard the result is
// applied to whatever is selected by then, which is not a cosmetic glitch: a reference
// clip uploaded under preset A lands in preset B's draft, and the next Save writes A's
// `ref_storage_key` and transcript onto B. That is silent data corruption, discovered
// weeks later when a voice sounds wrong.
//
// Two mechanisms, because they cover different halves:
//   - a TOKEN, checked before any result is applied. Covers work that cannot be cancelled
//     (an upload already on the wire, a decodeAudioData in progress) — the result arrives
//     and is dropped on the floor.
//   - an ABORT SIGNAL, so work that CAN be cancelled stops immediately. Covers the
//     audition, which otherwise keeps the rig's single inference slot busy rendering a
//     preset nobody is looking at while the newly selected one waits.

export interface GenerationHandle {
  /** Compare with `isStale` before applying anything this operation produced. */
  token: number
  /** Aborted by the next `reset()`. Pass to `fetch`. */
  signal: AbortSignal
}

export interface GenerationGuard {
  /** Claim the current generation for an operation starting now. */
  begin: () => GenerationHandle
  /** True once the selection has moved on — the caller must discard its result. */
  isStale: (token: number) => boolean
  /** The signal for the CURRENT generation, for callers that need it without a token. */
  signal: () => AbortSignal
  /** The selection changed: every outstanding token goes stale and every request
   *  holding the current signal aborts. */
  reset: () => void
}

export function createGenerationGuard(): GenerationGuard {
  let generation = 0
  let controller = new AbortController()

  return {
    begin: () => ({ token: generation, signal: controller.signal }),
    isStale: (token: number) => token !== generation,
    signal: () => controller.signal,
    reset: () => {
      generation++
      controller.abort()
      // A fresh controller, so the NEXT generation's work is not born pre-aborted.
      controller = new AbortController()
    }
  }
}

/** True when a rejection is the guard's own abort rather than a real failure — an
 *  abandoned request must not be reported to the user as an error. */
export function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError'
}
