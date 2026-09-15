import { describe, it, expect } from 'vitest'
import { createGenerationGuard, isAbortError } from './generation'
import { runAuditionSequentially, type SpeakRequestBody } from './studio'

describe('createGenerationGuard', () => {
  it('a token is fresh until the selection changes', () => {
    const guard = createGenerationGuard()
    const { token } = guard.begin()
    expect(guard.isStale(token)).toBe(false)
    guard.reset()
    expect(guard.isStale(token)).toBe(true)
  })

  it('every outstanding token goes stale at once, however many there are', () => {
    const guard = createGenerationGuard()
    const a = guard.begin().token
    const b = guard.begin().token
    guard.reset()
    expect(guard.isStale(a)).toBe(true)
    expect(guard.isStale(b)).toBe(true)
  })

  it('aborts the signal held by in-flight work', () => {
    const guard = createGenerationGuard()
    const { signal } = guard.begin()
    expect(signal.aborted).toBe(false)
    guard.reset()
    expect(signal.aborted).toBe(true)
  })

  it('hands the NEXT generation a signal that is not already aborted', () => {
    // A single shared controller would leave every later request born cancelled.
    const guard = createGenerationGuard()
    guard.begin()
    guard.reset()
    const next = guard.begin()
    expect(next.signal.aborted).toBe(false)
    expect(guard.isStale(next.token)).toBe(false)
  })

  it('survives repeated resets', () => {
    const guard = createGenerationGuard()
    const first = guard.begin()
    guard.reset()
    guard.reset()
    guard.reset()
    expect(guard.isStale(first.token)).toBe(true)
    const latest = guard.begin()
    expect(guard.isStale(latest.token)).toBe(false)
    expect(latest.signal.aborted).toBe(false)
  })
})

describe('isAbortError', () => {
  it('recognises the guard\'s own cancellation', () => {
    const err = new DOMException('aborted', 'AbortError')
    expect(isAbortError(err)).toBe(true)
  })

  it('does not swallow a real failure', () => {
    expect(isAbortError(new Error('the rig is on fire'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
    expect(isAbortError('AbortError')).toBe(false)
  })
})

// ── The two races the guard exists for, modelled end to end ───────────────────
//
// These mirror what DesignPane does: the same guard, the same token-then-apply order, the
// same abort plumbing. A component mount would add Nuxt auto-imports and Nuxt UI to the
// test with no extra coverage of the logic that was actually wrong.

describe('a reference upload that lands after a preset switch', () => {
  /** `uploadReference`, reduced to its race: await the server, then write the draft. */
  async function uploadReference(
    guard: ReturnType<typeof createGenerationGuard>,
    draft: { refStorageKey: string | null, refText: string, refDurationMs: number | null },
    request: Promise<{ storageKey: string, refText: string, durationMs: number }>,
    state: { busy: boolean }
  ) {
    const { token } = guard.begin()
    state.busy = true
    try {
      const res = await request
      if (guard.isStale(token)) return // the whole fix
      draft.refStorageKey = res.storageKey
      draft.refText = res.refText
      draft.refDurationMs = res.durationMs
    } finally {
      if (!guard.isStale(token)) state.busy = false
    }
  }

  it('does NOT write preset A\'s clip into the newly selected preset B', async () => {
    const guard = createGenerationGuard()
    // The draft object is reused across presets — the watcher overwrites it in place,
    // which is exactly why a late result can land on the wrong one.
    const draft = { refStorageKey: null as string | null, refText: '', refDurationMs: null as number | null }
    const state = { busy: false }

    let land: (v: { storageKey: string, refText: string, durationMs: number }) => void = () => {}
    const request = new Promise<{ storageKey: string, refText: string, durationMs: number }>((resolve) => {
      land = resolve
    })

    const inFlight = uploadReference(guard, draft, request, state)

    // The user picks preset B while A's upload is still on the wire.
    guard.reset()
    Object.assign(draft, { refStorageKey: null, refText: '', refDurationMs: null }) // B's values

    land({ storageKey: 'blob/preset-A-clip', refText: 'A\'s transcript', durationMs: 9000 })
    await inFlight

    // Without the staleness check this is 'blob/preset-A-clip' — and the next Save
    // persists A's reference onto B.
    expect(draft.refStorageKey).toBeNull()
    expect(draft.refText).toBe('')
    expect(draft.refDurationMs).toBeNull()
  })

  it('still applies normally when the selection did NOT change', async () => {
    const guard = createGenerationGuard()
    const draft = { refStorageKey: null as string | null, refText: '', refDurationMs: null as number | null }
    const state = { busy: false }
    await uploadReference(
      guard,
      draft,
      Promise.resolve({ storageKey: 'blob/k', refText: 'the transcript', durationMs: 9000 }),
      state
    )
    expect(draft.refStorageKey).toBe('blob/k')
    expect(draft.refText).toBe('the transcript')
    expect(state.busy).toBe(false)
  })

  it('leaves the NEW preset\'s busy flag alone when a stale upload settles', async () => {
    // The stale run's `finally` must not clear a spinner that now belongs to preset B.
    const guard = createGenerationGuard()
    const draft = { refStorageKey: null as string | null, refText: '', refDurationMs: null as number | null }
    const state = { busy: false }

    let land: (v: { storageKey: string, refText: string, durationMs: number }) => void = () => {}
    const request = new Promise<{ storageKey: string, refText: string, durationMs: number }>((resolve) => {
      land = resolve
    })
    const inFlight = uploadReference(guard, draft, request, state)

    guard.reset()
    state.busy = true // B started its own upload
    land({ storageKey: 'blob/preset-A-clip', refText: 'A\'s transcript', durationMs: 9000 })
    await inFlight

    expect(state.busy).toBe(true)
  })
})

describe('switching presets mid-audition', () => {
  const body = (seed: number): SpeakRequestBody => ({
    text: 'audition line',
    presetId: 'preset-A',
    format: 'wav',
    overrides: { seed }
  })

  it('abandons the old run instead of holding the rig for a preset nobody is looking at', async () => {
    const guard = createGenerationGuard()
    const { token, signal } = guard.begin()
    const requests = [body(1), body(2), body(3), body(4)]
    const sent: number[] = []
    const applied: number[] = []
    let auditioning = true

    // `send` honours the signal, exactly as renderWav does once it is passed through.
    const send = async (b: SpeakRequestBody) => {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      sent.push(b.overrides?.seed ?? -1)
      await Promise.resolve()
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      return 'rendered'
    }

    const run = (async () => {
      try {
        await runAuditionSequentially(requests, send, {
          onDone: (i) => {
            if (guard.isStale(token)) return
            applied.push(i)
          },
          onError: (_i, err) => {
            // An abandoned take is not a failure to report.
            if (guard.isStale(token) || isAbortError(err)) return
            applied.push(-1)
          }
        })
      } finally {
        // Guarded, so an abandoned run cannot clear a spinner that now belongs to B.
        if (!guard.isStale(token)) auditioning = false
      }
    })()

    // Let the first take get going, then switch preset.
    await Promise.resolve()
    guard.reset()
    await run

    // The remaining takes were never sent — the rig's single slot is free for B.
    expect(sent.length).toBeLessThan(requests.length)
    // Nothing from the abandoned run reached the newly selected preset's UI.
    expect(applied).toEqual([])
    // And the stale run did not touch the flag that drives B's button.
    expect(auditioning).toBe(true)
  })

  it('runs to completion, and clears its own flag, when nothing switches', async () => {
    const guard = createGenerationGuard()
    const { token, signal } = guard.begin()
    const requests = [body(1), body(2), body(3), body(4)]
    const applied: number[] = []
    let auditioning = true

    const send = async (b: SpeakRequestBody) => {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      return `rendered ${b.overrides?.seed}`
    }

    try {
      await runAuditionSequentially(requests, send, {
        onDone: (i) => {
          if (guard.isStale(token)) return
          applied.push(i)
        }
      })
    } finally {
      if (!guard.isStale(token)) auditioning = false
    }

    expect(applied).toEqual([0, 1, 2, 3])
    expect(auditioning).toBe(false)
  })
})
